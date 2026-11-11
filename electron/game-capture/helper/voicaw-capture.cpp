// voicaw-capture.exe: game capture for the desktop app on Windows (electron/gameCapture.js runs
// it; see Game capture in docs/desktop-and-site.md). A game in exclusive full screen never
// reaches the desktop, so Windows' own capture (what getDisplayMedia uses) sees a frozen
// picture. Like Discord and OBS, we capture from inside the game instead: OBS's graphics hook
// (shipped unmodified beside this program) is loaded into the game by OBS's inject helper,
// copies each frame it presents into a shared texture, and this program copies that texture into
// a few textures of its own that Electron can import (NT handles, duplicated into the app's main
// process), telling the app which one holds the newest frame.
//
//   voicaw-capture.exe --list <pid>[,<pid>...]
//       Prints {"windows":[{hwnd, pid, title, width, height}]}: those processes' visible
//       top-level windows (the picker's Games tab).
//   voicaw-capture.exe --hwnd <window> --parent <app pid> --dir <hook files> [--fps <n>]
//       Captures the game owning <window>. Speaks one JSON object per line on stdout:
//         {"event":"log","message"}           what the hook or this program says
//         {"event":"ready","gen","width","height","format","handles":[...]}
//             a new set of textures (handles are valid in the app's process); `gen` counts them
//         {"event":"frame","gen","slot","timestamp"}  slot <n> holds a new frame (µs)
//         {"event":"error","code","message"}  then it exits (codes: see fail())
//         {"event":"stopped","reason"}        then it exits
//       and reads lines on stdin: "free <gen> <slot>" (the app is done with that frame),
//       "retire <gen>" (the app has moved on to a newer set: close the old one), "fps <n>",
//       "stop". Its stdin closing (the app gone) stops it too.
//
// Only this file and hook-protocol.h are ours; the hook, inject helper and offsets program are
// OBS's (GPL v2, see LICENSE-OBS.txt beside them).

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <mmsystem.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <shellapi.h>

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cwchar>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "hook-protocol.h"

#ifndef CREATE_WAITABLE_TIMER_HIGH_RESOLUTION
#define CREATE_WAITABLE_TIMER_HIGH_RESOLUTION 0x00000002
#endif

namespace {

constexpr int SLOTS = 4;
constexpr DWORD INJECT_TIMEOUT_MS = 15000;  // the inject helper's own run
constexpr DWORD HOOK_LOAD_TIMEOUT_MS = 15000; // the hook appearing in the game
constexpr DWORD HOOK_READY_TIMEOUT_MS = 20000; // its first frame (a game on a menu still presents)
constexpr DWORD GPU_WAIT_MS = 200;

// ---- output ------------------------------------------------------------------------------

std::mutex out_lock;

std::string utf8(const wchar_t *text, int length = -1)
{
    if (!text) return {};
    const int size = WideCharToMultiByte(CP_UTF8, 0, text, length, nullptr, 0, nullptr, nullptr);
    if (size <= 0) return {};
    std::string out(size, '\0');
    WideCharToMultiByte(CP_UTF8, 0, text, length, &out[0], size, nullptr, nullptr);
    if (length < 0 && !out.empty() && out.back() == '\0') out.pop_back();
    return out;
}

std::string json_string(const std::string &text)
{
    std::string out = "\"";
    for (unsigned char c : text) {
        switch (c) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
            if (c < 0x20) {
                char escaped[8];
                snprintf(escaped, sizeof(escaped), "\\u%04x", c);
                out += escaped;
            } else {
                out += static_cast<char>(c);
            }
        }
    }
    return out + "\"";
}

void emit(const std::string &line)
{
    std::lock_guard<std::mutex> guard(out_lock);
    fwrite(line.data(), 1, line.size(), stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

void log_line(const std::string &message)
{
    emit("{\"event\":\"log\",\"message\":" + json_string(message) + "}");
}

std::string format_error(DWORD error)
{
    char text[32];
    snprintf(text, sizeof(text), " (%lu)", static_cast<unsigned long>(error));
    return text;
}

// What fail() tidies up first: the textures passed to the app, and the hook (see Capture).
void (*on_fail)() = nullptr;

// Codes the app knows (electron/gameCapture.js): bad_arguments, no_window, process_access,
// elevated, offsets_failed, inject_failed, hook_not_loaded, hook_not_ready, hook_version,
// no_frame_data, unsupported_format, no_adapter, texture_failed, parent_access.
[[noreturn]] void fail(const char *code, const std::string &message)
{
    if (on_fail) on_fail();
    emit(std::string("{\"event\":\"error\",\"code\":\"") + code + "\",\"message\":" + json_string(message) + "}");
    ExitProcess(1);
}

template <typename T> struct Com {
    T *p = nullptr;
    Com() = default;
    Com(const Com &) = delete;
    Com &operator=(const Com &) = delete;
    ~Com() { reset(); }
    void reset()
    {
        if (p) p->Release();
        p = nullptr;
    }
    T **out()
    {
        reset();
        return &p;
    }
    T *operator->() const { return p; }
    explicit operator bool() const { return p != nullptr; }
};

std::wstring named(const wchar_t *base, DWORD id)
{
    wchar_t name[96];
    swprintf(name, 96, L"%ls%lu", base, static_cast<unsigned long>(id));
    return name;
}

bool signalled(HANDLE handle)
{
    return handle && WaitForSingleObject(handle, 0) == WAIT_OBJECT_0;
}

void close(HANDLE &handle)
{
    if (handle && handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    handle = nullptr;
}

// ---- running OBS's programs --------------------------------------------------------------

// Runs `command_line`; resolves to its exit code (and stdout, if `output`), or false if it
// couldn't start or ran past `timeout_ms` (then it's killed).
bool run_program(const std::wstring &program, std::wstring command_line, DWORD timeout_ms, DWORD *exit_code,
                 std::string *output)
{
    SECURITY_ATTRIBUTES sa = {sizeof(sa), nullptr, TRUE};
    HANDLE read_end = nullptr, write_end = nullptr;
    if (output) {
        if (!CreatePipe(&read_end, &write_end, &sa, 0)) return false;
        SetHandleInformation(read_end, HANDLE_FLAG_INHERIT, 0);
    }
    STARTUPINFOW si = {};
    si.cb = sizeof(si);
    if (output) {
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdOutput = write_end;
        si.hStdError = write_end;
        si.hStdInput = nullptr;
    }
    PROCESS_INFORMATION pi = {};
    const BOOL started = CreateProcessW(program.c_str(), &command_line[0], nullptr, nullptr, output ? TRUE : FALSE,
                                        CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi);
    if (write_end) CloseHandle(write_end);
    if (!started) {
        if (read_end) CloseHandle(read_end);
        return false;
    }
    CloseHandle(pi.hThread);
    if (output) {
        char buffer[1024];
        DWORD got = 0;
        while (ReadFile(read_end, buffer, sizeof(buffer), &got, nullptr) && got) output->append(buffer, got);
        CloseHandle(read_end);
    }
    const DWORD waited = WaitForSingleObject(pi.hProcess, timeout_ms);
    if (waited != WAIT_OBJECT_0) {
        TerminateProcess(pi.hProcess, 1);
        CloseHandle(pi.hProcess);
        return false;
    }
    GetExitCodeProcess(pi.hProcess, exit_code);
    CloseHandle(pi.hProcess);
    return true;
}

// get-graphics-offsets prints an ini: [d3d8] present=0x… [d3d9] … [dxgi] present=… release=….
bool parse_offsets(const std::string &text, hook_graphics_offsets &offsets)
{
    std::memset(&offsets, 0, sizeof(offsets));
    std::string section;
    size_t start = 0;
    int found = 0;
    while (start < text.size()) {
        size_t end = text.find('\n', start);
        if (end == std::string::npos) end = text.size();
        std::string line = text.substr(start, end - start);
        start = end + 1;
        while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
        if (line.empty()) continue;
        if (line.front() == '[' && line.back() == ']') {
            section = line.substr(1, line.size() - 2);
            continue;
        }
        const size_t eq = line.find('=');
        if (eq == std::string::npos) continue;
        const std::string key = line.substr(0, eq);
        const uint32_t value = static_cast<uint32_t>(strtoul(line.c_str() + eq + 1, nullptr, 0));
        uint32_t *field = nullptr;
        if (section == "d3d8" && key == "present") field = &offsets.d3d8.present;
        else if (section == "d3d9" && key == "present") field = &offsets.d3d9.present;
        else if (section == "d3d9" && key == "present_ex") field = &offsets.d3d9.present_ex;
        else if (section == "d3d9" && key == "present_swap") field = &offsets.d3d9.present_swap;
        else if (section == "d3d9" && key == "d3d9_clsoff") field = &offsets.d3d9.d3d9_clsoff;
        else if (section == "d3d9" && key == "is_d3d9ex_clsoff") field = &offsets.d3d9.is_d3d9ex_clsoff;
        else if (section == "dxgi" && key == "present") field = &offsets.dxgi.present;
        else if (section == "dxgi" && key == "present1") field = &offsets.dxgi.present1;
        else if (section == "dxgi" && key == "resize") field = &offsets.dxgi.resize;
        else if (section == "dxgi" && key == "release") field = &offsets.dxgi2.release;
        if (field) {
            *field = value;
            found++;
        }
    }
    return found > 0 && offsets.dxgi.present != 0;
}

// ---- the hook's log pipe -----------------------------------------------------------------

// The hook writes its log to \\.\pipe\CaptureHook_Pipe<pid> when it can open it (it carries on
// without). We pass its lines on as log events, for working out why a game didn't capture.
void serve_hook_log(DWORD pid, std::atomic<bool> *stopping)
{
    const std::wstring name = L"\\\\.\\pipe\\" + named(HOOK_PIPE, pid);
    while (!stopping->load()) {
        HANDLE pipe = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_INBOUND,
                                       PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT, 1, 0, 4096, 0, nullptr);
        if (pipe == INVALID_HANDLE_VALUE) return;
        if (ConnectNamedPipe(pipe, nullptr) || GetLastError() == ERROR_PIPE_CONNECTED) {
            char buffer[4096];
            DWORD got = 0;
            while (!stopping->load()) {
                const BOOL ok = ReadFile(pipe, buffer, sizeof(buffer) - 1, &got, nullptr);
                if (!ok && GetLastError() != ERROR_MORE_DATA) break;
                buffer[got] = '\0';
                std::string text(buffer, strnlen(buffer, got));
                while (!text.empty() && (text.back() == '\n' || text.back() == '\r')) text.pop_back();
                if (!text.empty()) log_line("hook: " + text);
            }
        }
        CloseHandle(pipe);
    }
}

// ---- commands from the app ---------------------------------------------------------------

struct Commands {
    std::mutex lock;
    std::deque<std::string> lines;
    std::atomic<bool> closed{false};

    void start()
    {
        std::thread([this] {
            HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
            std::string pending;
            char buffer[512];
            DWORD got = 0;
            while (ReadFile(input, buffer, sizeof(buffer), &got, nullptr) && got) {
                pending.append(buffer, got);
                size_t end;
                while ((end = pending.find('\n')) != std::string::npos) {
                    std::string line = pending.substr(0, end);
                    pending.erase(0, end + 1);
                    if (!line.empty() && line.back() == '\r') line.pop_back();
                    std::lock_guard<std::mutex> guard(lock);
                    lines.push_back(line);
                }
            }
            closed = true;
        }).detach();
    }

    bool next(std::string &line)
    {
        std::lock_guard<std::mutex> guard(lock);
        if (lines.empty()) return false;
        line = lines.front();
        lines.pop_front();
        return true;
    }
};

// ---- formats -----------------------------------------------------------------------------

// What Electron's sharedTexture calls the format we hand it, and the DXGI format of our copies
// (a typeless or sRGB source copies into the plain UNORM one: the same bytes). Others (10-bit,
// 16-bit, BGRX) aren't supported yet: the app falls back to window capture.
struct OutFormat {
    const char *name;
    DXGI_FORMAT dxgi;
};

bool out_format(DXGI_FORMAT source, OutFormat &out)
{
    switch (source) {
    case DXGI_FORMAT_B8G8R8A8_UNORM:
    case DXGI_FORMAT_B8G8R8A8_UNORM_SRGB:
    case DXGI_FORMAT_B8G8R8A8_TYPELESS:
        out = {"bgra", DXGI_FORMAT_B8G8R8A8_UNORM};
        return true;
    case DXGI_FORMAT_R8G8B8A8_UNORM:
    case DXGI_FORMAT_R8G8B8A8_UNORM_SRGB:
    case DXGI_FORMAT_R8G8B8A8_TYPELESS:
        out = {"rgba", DXGI_FORMAT_R8G8B8A8_UNORM};
        return true;
    case DXGI_FORMAT_R16G16B16A16_FLOAT:
    case DXGI_FORMAT_R16G16B16A16_TYPELESS:
        out = {"rgbaf16", DXGI_FORMAT_R16G16B16A16_FLOAT};
        return true;
    default:
        return false;
    }
}

uint32_t bytes_per_pixel(DXGI_FORMAT format)
{
    return format == DXGI_FORMAT_R16G16B16A16_FLOAT ? 8 : 4;
}

// ---- the capture -------------------------------------------------------------------------

struct Slot {
    Com<ID3D11Texture2D> texture;
    HANDLE own_handle = nullptr;   // the NT handle in this process
    uint64_t app_handle = 0;       // its duplicate in the app's process
    bool busy = false;             // the app hasn't said "free" yet
};

struct TextureSet {
    uint32_t gen = 0;
    Slot slots[SLOTS];
};

class Capture {
public:
    Capture(HWND window, DWORD parent_pid, std::wstring dir, int fps)
        : window_(window), parent_pid_(parent_pid), dir_(std::move(dir)), fps_(fps)
    {
    }

    int run();
    // Closes our textures' handles in the app's process and stops the hook (also on fail()).
    void cleanup();

private:
    HWND window_;
    DWORD parent_pid_;
    std::wstring dir_;
    int fps_;

    DWORD pid_ = 0, thread_id_ = 0;
    bool game_64bit_ = true;
    HANDLE process_ = nullptr, parent_ = nullptr;
    HANDLE keepalive_ = nullptr;
    HANDLE ev_restart_ = nullptr, ev_stop_ = nullptr, ev_init_ = nullptr, ev_ready_ = nullptr, ev_exit_ = nullptr;
    HANDLE tex_mutexes_[2] = {nullptr, nullptr};
    HANDLE info_map_ = nullptr;
    hook_info *info_ = nullptr;
    HANDLE data_map_ = nullptr;
    void *data_ = nullptr;
    hook_graphics_offsets offsets_ = {};

    Com<ID3D11Device> device_;
    Com<ID3D11DeviceContext> context_;
    Com<ID3D11Query> query_;
    Com<ID3D11Texture2D> source_; // the hook's shared texture (TEXTURE), opened on our device
    hook_capture_type type_ = HOOK_CAPTURE_TEXTURE;
    DXGI_FORMAT source_format_ = DXGI_FORMAT_UNKNOWN;
    OutFormat out_ = {};
    uint32_t width_ = 0, height_ = 0, pitch_ = 0;

    std::vector<TextureSet *> sets_; // the current one last; older ones until "retire"
    uint32_t next_gen_ = 1;

    Commands commands_;
    std::atomic<bool> stopping_{false};

    void open_game();
    void load_offsets();
    bool existing_hook();
    void inject();
    void wait_for_hook();
    void fill_hook_info();
    bool wait_ready(DWORD timeout_ms);
    bool start_capture();
    bool open_texture_on_some_adapter(HANDLE shared);
    bool make_device(IDXGIAdapter1 *adapter);
    void make_textures();
    void retire(uint32_t gen);
    void close_app_handle(uint64_t handle);
    bool copy_frame(Slot &slot);
    bool wait_gpu();
    void handle_commands(bool &stop);
    void set_frame_interval();
    void stop_hook();
};

void Capture::open_game()
{
    if (!IsWindow(window_)) fail("no_window", "The game's window has gone.");
    thread_id_ = GetWindowThreadProcessId(window_, &pid_);
    if (!thread_id_ || !pid_) fail("no_window", "Could not find the game's process." + format_error(GetLastError()));
    if (pid_ == GetCurrentProcessId() || pid_ == parent_pid_) fail("no_window", "That's Voicaw's own window.");

    process_ = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid_);
    if (!process_) fail("process_access", "Could not open the game's process." + format_error(GetLastError()));
    // A game running as administrator lets us look but not hook (Windows keeps a normal
    // program's hooks out of it): the app says to run Voicaw as administrator too.
    HANDLE full = OpenProcess(PROCESS_QUERY_INFORMATION, FALSE, pid_);
    if (!full && GetLastError() == ERROR_ACCESS_DENIED) {
        fail("elevated", "The game runs as administrator.");
    }
    if (full) CloseHandle(full);

    BOOL wow64 = FALSE;
    IsWow64Process(process_, &wow64);
    game_64bit_ = !wow64;

    parent_ = OpenProcess(PROCESS_DUP_HANDLE, FALSE, parent_pid_);
    if (!parent_) fail("parent_access", "Could not reach the app's process." + format_error(GetLastError()));
}

void Capture::load_offsets()
{
    const std::wstring program = dir_ + (game_64bit_ ? L"\\get-graphics-offsets64.exe" : L"\\get-graphics-offsets32.exe");
    std::string output;
    DWORD code = 1;
    if (!run_program(program, L"\"" + program + L"\"", 10000, &code, &output) || !parse_offsets(output, offsets_)) {
        fail("offsets_failed", "Could not work out the graphics hook's offsets: " + output.substr(0, 200));
    }
}

// A game hooked before (by an earlier share, or by OBS itself) only needs telling to restart.
bool Capture::existing_hook()
{
    ev_restart_ = OpenEventW(EVENT_MODIFY_STATE | SYNCHRONIZE, FALSE, named(HOOK_EVENT_RESTART, pid_).c_str());
    if (!ev_restart_) return false;
    log_line("the game is already hooked: restarting its capture");
    SetEvent(ev_restart_);
    return true;
}

// The "compatibility" way (OBS's default, safest with anti-cheat): the inject helper loads the
// hook through a Windows message hook on the game window's thread, never opening the process
// for writing.
void Capture::inject()
{
    const wchar_t *arch = game_64bit_ ? L"64" : L"32";
    const std::wstring helper = dir_ + L"\\inject-helper" + arch + L".exe";
    const std::wstring hook = dir_ + L"\\graphics-hook" + arch + L".dll";
    if (GetFileAttributesW(helper.c_str()) == INVALID_FILE_ATTRIBUTES || GetFileAttributesW(hook.c_str()) == INVALID_FILE_ATTRIBUTES) {
        fail("inject_failed", "The game capture files are missing (an antivirus may have removed them).");
    }
    wchar_t tail[32];
    swprintf(tail, 32, L" 1 %lu", static_cast<unsigned long>(thread_id_));
    DWORD code = 1;
    if (!run_program(helper, L"\"" + helper + L"\" \"" + hook + L"\"" + tail, INJECT_TIMEOUT_MS, &code, nullptr)) {
        fail("inject_failed", "The inject helper didn't run (an antivirus may have blocked it).");
    }
    if (code != 0) {
        char text[64];
        snprintf(text, sizeof(text), "The inject helper failed (%ld).", static_cast<long>(code));
        fail("inject_failed", text);
    }
}

// The hook makes its texture mutexes as it loads; then its events and info block exist too.
void Capture::wait_for_hook()
{
    const ULONGLONG until = GetTickCount64() + HOOK_LOAD_TIMEOUT_MS;
    for (;;) {
        tex_mutexes_[0] = OpenMutexW(SYNCHRONIZE, FALSE, named(HOOK_MUTEX_TEXTURE1, pid_).c_str());
        tex_mutexes_[1] = OpenMutexW(SYNCHRONIZE, FALSE, named(HOOK_MUTEX_TEXTURE2, pid_).c_str());
        if (tex_mutexes_[0] && tex_mutexes_[1]) break;
        close(tex_mutexes_[0]);
        close(tex_mutexes_[1]);
        if (signalled(process_)) fail("no_window", "The game closed.");
        if (GetTickCount64() > until) {
            fail("hook_not_loaded", "The game didn't load the capture hook (its anti-cheat may block it).");
        }
        Sleep(100);
    }
    info_map_ = OpenFileMappingW(FILE_MAP_READ | FILE_MAP_WRITE, FALSE, named(HOOK_SHMEM_INFO, pid_).c_str());
    if (!info_map_) fail("hook_not_loaded", "Could not open the hook's info." + format_error(GetLastError()));
    info_ = static_cast<hook_info *>(MapViewOfFile(info_map_, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(hook_info)));
    if (!info_) fail("hook_not_loaded", "Could not map the hook's info." + format_error(GetLastError()));

    const DWORD access = EVENT_MODIFY_STATE | SYNCHRONIZE;
    if (!ev_restart_) ev_restart_ = OpenEventW(access, FALSE, named(HOOK_EVENT_RESTART, pid_).c_str());
    ev_stop_ = OpenEventW(access, FALSE, named(HOOK_EVENT_STOP, pid_).c_str());
    ev_init_ = OpenEventW(access, FALSE, named(HOOK_EVENT_INIT, pid_).c_str());
    ev_ready_ = OpenEventW(access, FALSE, named(HOOK_EVENT_READY, pid_).c_str());
    ev_exit_ = OpenEventW(access, FALSE, named(HOOK_EVENT_EXIT, pid_).c_str());
    if (!ev_restart_ || !ev_stop_ || !ev_init_ || !ev_ready_ || !ev_exit_) {
        fail("hook_not_loaded", "Could not open the hook's events." + format_error(GetLastError()));
    }
}

void Capture::set_frame_interval()
{
    if (info_) info_->frame_interval = fps_ > 0 ? 1000000000ULL / static_cast<uint64_t>(fps_) : 0;
}

void Capture::fill_hook_info()
{
    info_->offsets = offsets_;
    info_->capture_overlay = false;
    info_->force_shmem = false;
    info_->unused_use_scale = false;
    info_->allow_srgb_alias = true;
    set_frame_interval();
}

bool Capture::wait_ready(DWORD timeout_ms)
{
    const ULONGLONG until = GetTickCount64() + timeout_ms;
    while (GetTickCount64() < until) {
        if (WaitForSingleObject(ev_ready_, 50) == WAIT_OBJECT_0) return true;
        if (signalled(process_)) fail("no_window", "The game closed.");
        if (commands_.closed) return false;
    }
    return false;
}

bool Capture::make_device(IDXGIAdapter1 *adapter)
{
    const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1,
                                        D3D_FEATURE_LEVEL_10_0};
    HRESULT hr = D3D11CreateDevice(adapter, adapter ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_HARDWARE, nullptr,
                                   D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, 4, D3D11_SDK_VERSION, device_.out(),
                                   nullptr, context_.out());
    if (FAILED(hr)) {
        // 11.1 isn't known to Windows 7's runtime: ask again without it.
        hr = D3D11CreateDevice(adapter, adapter ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_HARDWARE, nullptr,
                               D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels + 1, 3, D3D11_SDK_VERSION, device_.out(),
                               nullptr, context_.out());
    }
    if (FAILED(hr)) return false;
    D3D11_QUERY_DESC qd = {D3D11_QUERY_EVENT, 0};
    return SUCCEEDED(device_->CreateQuery(&qd, query_.out()));
}

// A legacy shared handle only opens on the adapter (GPU) the game made it on, so try each.
bool Capture::open_texture_on_some_adapter(HANDLE shared)
{
    Com<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void **>(factory.out())))) return false;
    for (UINT i = 0;; i++) {
        Com<IDXGIAdapter1> adapter;
        if (factory->EnumAdapters1(i, adapter.out()) == DXGI_ERROR_NOT_FOUND) break;
        if (!make_device(adapter.p)) continue;
        if (SUCCEEDED(device_->OpenSharedResource(shared, __uuidof(ID3D11Texture2D),
                                                  reinterpret_cast<void **>(source_.out())))) {
            DXGI_ADAPTER_DESC1 desc = {};
            adapter->GetDesc1(&desc);
            log_line("capturing on " + utf8(desc.Description));
            return true;
        }
    }
    device_.reset();
    context_.reset();
    query_.reset();
    return false;
}

void Capture::close_app_handle(uint64_t handle)
{
    if (!handle) return;
    // Closes our duplicate inside the app's process (Electron duplicates it again on import).
    DuplicateHandle(parent_, reinterpret_cast<HANDLE>(static_cast<uintptr_t>(handle)), nullptr, nullptr, 0, FALSE,
                    DUPLICATE_CLOSE_SOURCE);
}

void Capture::retire(uint32_t gen)
{
    for (size_t i = 0; i < sets_.size();) {
        TextureSet *set = sets_[i];
        if (set->gen <= gen && set != sets_.back()) {
            for (Slot &slot : set->slots) {
                close_app_handle(slot.app_handle);
                close(slot.own_handle);
            }
            delete set;
            sets_.erase(sets_.begin() + static_cast<long>(i));
        } else {
            i++;
        }
    }
}

// SLOTS textures the size and format of the game's frames, each shared as an NT handle
// duplicated into the app's process; announced as a new `gen`.
void Capture::make_textures()
{
    auto *set = new TextureSet();
    set->gen = next_gen_++;
    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = width_;
    desc.Height = height_;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = out_.dxgi;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
    desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED;
    std::string handles;
    for (Slot &slot : set->slots) {
        if (FAILED(device_->CreateTexture2D(&desc, nullptr, slot.texture.out()))) {
            fail("texture_failed", "Could not make a texture for the frames.");
        }
        Com<IDXGIResource1> resource;
        if (FAILED(slot.texture->QueryInterface(__uuidof(IDXGIResource1), reinterpret_cast<void **>(resource.out()))) ||
            FAILED(resource->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, nullptr,
                                                &slot.own_handle))) {
            fail("texture_failed", "Could not share a texture for the frames.");
        }
        HANDLE theirs = nullptr;
        if (!DuplicateHandle(GetCurrentProcess(), slot.own_handle, parent_, &theirs, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
            fail("parent_access", "Could not pass a texture to the app." + format_error(GetLastError()));
        }
        slot.app_handle = static_cast<uint64_t>(reinterpret_cast<uintptr_t>(theirs));
        char text[32];
        snprintf(text, sizeof(text), "%s\"%llu\"", handles.empty() ? "" : ",",
                 static_cast<unsigned long long>(slot.app_handle));
        handles += text;
    }
    sets_.push_back(set);
    char head[160];
    snprintf(head, sizeof(head), "{\"event\":\"ready\",\"gen\":%u,\"width\":%u,\"height\":%u,\"format\":\"%s\",\"handles\":[",
             set->gen, width_, height_, out_.name);
    emit(std::string(head) + handles + "]}");
}

// The hook is ready: open what it captures into (again after a resize), make our textures.
bool Capture::start_capture()
{
    if (info_->hook_ver_major > HOOK_VER_MAJOR) {
        fail("hook_version", "The capture hook is newer than this helper understands.");
    }
    if (data_) UnmapViewOfFile(data_);
    data_ = nullptr;
    close(data_map_);
    source_.reset();

    wchar_t base[96];
    swprintf(base, 96, L"%ls_%llu_", HOOK_SHMEM_TEXTURE, static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(window_)));
    data_map_ = OpenFileMappingW(FILE_MAP_READ | FILE_MAP_WRITE, FALSE, named(base, info_->map_id).c_str());
    if (!data_map_) {
        // Some games capture another of their windows than the one picked: the hook says which.
        swprintf(base, 96, L"%ls_%llu_", HOOK_SHMEM_TEXTURE, static_cast<unsigned long long>(info_->window));
        data_map_ = OpenFileMappingW(FILE_MAP_READ | FILE_MAP_WRITE, FALSE, named(base, info_->map_id).c_str());
    }
    if (!data_map_) {
        log_line("the hook's frame data isn't there yet" + format_error(GetLastError()));
        return false;
    }
    data_ = MapViewOfFile(data_map_, FILE_MAP_ALL_ACCESS, 0, 0, info_->map_size);
    if (!data_) fail("no_frame_data", "Could not map the hook's frame data." + format_error(GetLastError()));

    type_ = info_->type;
    width_ = info_->cx;
    height_ = info_->cy;
    pitch_ = info_->pitch;
    if (!width_ || !height_) fail("no_frame_data", "The game reported an empty picture.");

    if (type_ == HOOK_CAPTURE_TEXTURE) {
        const HANDLE shared = reinterpret_cast<HANDLE>(static_cast<uintptr_t>(static_cast<hook_shtex_data *>(data_)->tex_handle));
        if (!open_texture_on_some_adapter(shared)) {
            fail("no_adapter", "Could not open the game's frames on any graphics card.");
        }
        D3D11_TEXTURE2D_DESC desc = {};
        source_->GetDesc(&desc);
        source_format_ = desc.Format;
        width_ = desc.Width;
        height_ = desc.Height;
    } else {
        source_format_ = static_cast<DXGI_FORMAT>(info_->format);
        if (!device_ && !make_device(nullptr)) fail("no_adapter", "Could not start Direct3D.");
    }
    if (!out_format(source_format_, out_)) {
        char text[96];
        snprintf(text, sizeof(text), "The game's picture format (%u) isn't supported yet.", static_cast<unsigned>(source_format_));
        fail("unsupported_format", text);
    }
    char text[160];
    snprintf(text, sizeof(text), "capturing %ux%u, format %u, by %s (hook %u.%u)", width_, height_,
             static_cast<unsigned>(source_format_), type_ == HOOK_CAPTURE_TEXTURE ? "shared texture" : "memory",
             info_->hook_ver_major, info_->hook_ver_minor);
    log_line(text);
    make_textures();
    return true;
}

bool Capture::wait_gpu()
{
    context_->End(query_.p);
    context_->Flush();
    const ULONGLONG until = GetTickCount64() + GPU_WAIT_MS;
    while (context_->GetData(query_.p, nullptr, 0, 0) == S_FALSE) {
        if (GetTickCount64() > until) return false;
        SwitchToThread();
    }
    return true;
}

bool Capture::copy_frame(Slot &slot)
{
    if (type_ == HOOK_CAPTURE_TEXTURE) {
        context_->CopyResource(slot.texture.p, source_.p);
    } else {
        auto *shmem = static_cast<hook_shmem_data *>(data_);
        int current = shmem->last_tex;
        if (current < 0 || current > 1) return false;
        HANDLE mutex = nullptr;
        if (WaitForSingleObject(tex_mutexes_[current], 0) == WAIT_OBJECT_0) {
            mutex = tex_mutexes_[current];
        } else if (WaitForSingleObject(tex_mutexes_[1 - current], 0) == WAIT_OBJECT_0) {
            current = 1 - current;
            mutex = tex_mutexes_[current];
        } else {
            return false;
        }
        const uint8_t *pixels = static_cast<uint8_t *>(data_) + (current == 0 ? shmem->tex1_offset : shmem->tex2_offset);
        const uint32_t row = width_ * bytes_per_pixel(out_.dxgi);
        if (pitch_ >= row) context_->UpdateSubresource(slot.texture.p, 0, nullptr, pixels, pitch_, pitch_ * height_);
        ReleaseMutex(mutex);
        if (pitch_ < row) return false;
    }
    // The app reads the texture on another device as soon as we say: make sure it's written.
    return wait_gpu();
}

void Capture::handle_commands(bool &stop)
{
    std::string line;
    while (commands_.next(line)) {
        unsigned gen = 0, slot = 0;
        int fps = 0;
        if (sscanf(line.c_str(), "free %u %u", &gen, &slot) == 2) {
            for (TextureSet *set : sets_) {
                if (set->gen == gen && slot < SLOTS) set->slots[slot].busy = false;
            }
        } else if (sscanf(line.c_str(), "retire %u", &gen) == 1) {
            retire(gen);
        } else if (sscanf(line.c_str(), "fps %d", &fps) == 1 && fps > 0 && fps <= 240) {
            fps_ = fps;
            set_frame_interval();
        } else if (line == "stop") {
            stop = true;
        }
    }
    if (commands_.closed) stop = true;
}

void Capture::stop_hook()
{
    // Tells the hook to stop copying frames (it unloads nothing: the game keeps it, and a later
    // share restarts it); without our keepalive mutex it would stop within 5 s anyway.
    if (ev_stop_) SetEvent(ev_stop_);
    close(keepalive_);
}

void Capture::cleanup()
{
    stopping_ = true;
    stop_hook();
    for (TextureSet *set : sets_) {
        for (Slot &slot : set->slots) {
            close_app_handle(slot.app_handle);
            close(slot.own_handle);
        }
        delete set;
    }
    sets_.clear();
}

Capture *active_capture = nullptr;

int Capture::run()
{
    commands_.start();
    open_game();
    load_offsets();

    keepalive_ = CreateMutexW(nullptr, FALSE, named(HOOK_KEEPALIVE, pid_).c_str());
    if (!keepalive_) fail("hook_not_loaded", "Could not create the keepalive." + format_error(GetLastError()));
    std::thread(serve_hook_log, pid_, &stopping_).detach();

    if (!existing_hook()) {
        log_line(game_64bit_ ? "injecting the 64-bit hook" : "injecting the 32-bit hook");
        inject();
    }
    wait_for_hook();
    fill_hook_info();
    SetEvent(ev_init_);
    emit("{\"event\":\"log\",\"message\":\"waiting for the game's first frame\"}");

    bool capturing = false;
    const ULONGLONG ready_by = GetTickCount64() + HOOK_READY_TIMEOUT_MS;
    while (!capturing) {
        if (!wait_ready(500)) {
            if (commands_.closed) break;
            if (GetTickCount64() > ready_by) {
                fail("hook_not_ready", "The hook loaded but sent no frames (the game may use Vulkan, or block it).");
            }
            continue;
        }
        capturing = start_capture();
    }

    timeBeginPeriod(1);
    HANDLE timer = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
    if (!timer) timer = CreateWaitableTimerW(nullptr, FALSE, nullptr);

    const char *reason = "stopped";
    LARGE_INTEGER frequency, now;
    QueryPerformanceFrequency(&frequency);
    bool stop = !capturing;
    unsigned next_slot = 0;
    while (!stop) {
        LARGE_INTEGER due;
        due.QuadPart = -static_cast<LONGLONG>(10000000LL / (fps_ > 0 ? fps_ : 60));
        SetWaitableTimer(timer, &due, 0, nullptr, nullptr, FALSE);
        HANDLE waits[2] = {timer, process_};
        if (WaitForMultipleObjects(2, waits, FALSE, 1000) == WAIT_OBJECT_0 + 1) {
            reason = "game_closed";
            break;
        }
        handle_commands(stop);
        if (stop) break;
        if (!IsWindow(window_)) {
            reason = "game_closed";
            break;
        }
        // A resize (or a new swap chain) makes the hook start over and say ready again.
        if (signalled(ev_ready_)) {
            if (!start_capture()) continue;
        }
        // The hook stopped on its own (its device went, say): ask it to start again.
        if (signalled(ev_stop_)) {
            log_line("the hook stopped: restarting it");
            SetEvent(ev_restart_);
            fill_hook_info();
            SetEvent(ev_init_);
            if (!wait_ready(5000)) fail("hook_not_ready", "The hook stopped and didn't come back.");
            if (!start_capture()) continue;
        }
        TextureSet *set = sets_.back();
        Slot *slot = nullptr;
        for (int i = 0; i < SLOTS; i++) {
            Slot &candidate = set->slots[(next_slot + i) % SLOTS];
            if (!candidate.busy) {
                slot = &candidate;
                next_slot = (next_slot + i + 1) % SLOTS;
                break;
            }
        }
        if (!slot) continue; // the app hasn't caught up: drop this frame
        if (!copy_frame(*slot)) continue;
        slot->busy = true;
        QueryPerformanceCounter(&now);
        const unsigned long long us = static_cast<unsigned long long>(now.QuadPart) * 1000000ULL /
                                      static_cast<unsigned long long>(frequency.QuadPart);
        char line[128];
        snprintf(line, sizeof(line), "{\"event\":\"frame\",\"gen\":%u,\"slot\":%ld,\"timestamp\":%llu}", set->gen,
                 static_cast<long>(slot - set->slots), us);
        emit(line);
    }

    cleanup();
    if (timer) CloseHandle(timer);
    timeEndPeriod(1);
    emit(std::string("{\"event\":\"stopped\",\"reason\":\"") + reason + "\"}");
    return 0;
}

// ---- --list ------------------------------------------------------------------------------

struct ListState {
    std::vector<DWORD> pids;
    std::string out;
};

BOOL CALLBACK list_window(HWND hwnd, LPARAM param)
{
    auto *state = reinterpret_cast<ListState *>(param);
    if (!IsWindowVisible(hwnd) || GetWindow(hwnd, GW_OWNER)) return TRUE;
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    bool wanted = false;
    for (DWORD p : state->pids) wanted = wanted || p == pid;
    if (!wanted) return TRUE;
    RECT rect = {};
    GetClientRect(hwnd, &rect);
    if (rect.right - rect.left < 64 || rect.bottom - rect.top < 64) return TRUE;
    wchar_t title[256] = L"";
    GetWindowTextW(hwnd, title, 256);
    char head[128];
    snprintf(head, sizeof(head), "%s{\"hwnd\":\"%llu\",\"pid\":%lu,\"width\":%ld,\"height\":%ld,\"title\":",
             state->out.empty() ? "" : ",", static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(hwnd)),
             static_cast<unsigned long>(pid), rect.right - rect.left, rect.bottom - rect.top);
    state->out += head + json_string(utf8(title)) + "}";
    return TRUE;
}

int list_windows(const wchar_t *pids)
{
    ListState state;
    const wchar_t *p = pids;
    while (*p) {
        wchar_t *end = nullptr;
        const unsigned long pid = wcstoul(p, &end, 10);
        if (end == p) break;
        if (pid) state.pids.push_back(static_cast<DWORD>(pid));
        p = *end == L',' ? end + 1 : end;
    }
    if (!state.pids.empty()) EnumWindows(list_window, reinterpret_cast<LPARAM>(&state));
    emit("{\"windows\":[" + state.out + "]}");
    return 0;
}

} // namespace

int wmain(int argc, wchar_t **argv)
{
    SetErrorMode(SEM_FAILCRITICALERRORS);
    // Per-monitor aware, so window sizes are in real pixels.
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

    const wchar_t *list = nullptr, *dir = nullptr;
    unsigned long long hwnd = 0;
    unsigned long parent = 0;
    int fps = 60;
    for (int i = 1; i + 1 < argc; i += 2) {
        if (!wcscmp(argv[i], L"--list")) list = argv[i + 1];
        else if (!wcscmp(argv[i], L"--hwnd")) hwnd = wcstoull(argv[i + 1], nullptr, 10);
        else if (!wcscmp(argv[i], L"--parent")) parent = wcstoul(argv[i + 1], nullptr, 10);
        else if (!wcscmp(argv[i], L"--dir")) dir = argv[i + 1];
        else if (!wcscmp(argv[i], L"--fps")) fps = static_cast<int>(wcstol(argv[i + 1], nullptr, 10));
    }
    if (list) return list_windows(list);
    if (!hwnd || !parent || !dir || fps <= 0 || fps > 240) fail("bad_arguments", "voicaw-capture --hwnd --parent --dir [--fps]");
    Capture capture(reinterpret_cast<HWND>(static_cast<uintptr_t>(hwnd)), static_cast<DWORD>(parent), dir, fps);
    active_capture = &capture;
    on_fail = [] { active_capture->cleanup(); };
    return capture.run();
}
