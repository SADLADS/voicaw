// The game capture hook's side of the conversation (OBS's graphics-hook DLL, which Voicaw ships
// unmodified; see Game capture in docs/desktop-and-site.md): the names of the kernel objects it
// opens or creates, and the layout of the two shared memory blocks. This is our own declaration
// of that interface, written to match OBS 33's shared/obs-hook-config/graphics-hook-info.h: the
// sizes are checked below, so a field out of place fails to compile rather than corrupting the
// game's memory. HOOK_VER_MAJOR is the newest hook major version this helper understands.
#pragma once

#include <stdint.h>

#define HOOK_VER_MAJOR 1

// Each name is followed by the game's process id (the texture block's by its window and map id).
#define HOOK_EVENT_RESTART L"CaptureHook_Restart"
#define HOOK_EVENT_STOP L"CaptureHook_Stop"
#define HOOK_EVENT_READY L"CaptureHook_HookReady"
#define HOOK_EVENT_EXIT L"CaptureHook_Exit"
#define HOOK_EVENT_INIT L"CaptureHook_Initialize"
#define HOOK_KEEPALIVE L"CaptureHook_KeepAlive"
#define HOOK_MUTEX_TEXTURE1 L"CaptureHook_TextureMutex1"
#define HOOK_MUTEX_TEXTURE2 L"CaptureHook_TextureMutex2"
#define HOOK_SHMEM_INFO L"CaptureHook_HookInfo"
#define HOOK_SHMEM_TEXTURE L"CaptureHook_Texture"
// The hook writes its log lines here when someone listens (\\.\pipe\CaptureHook_Pipe<pid>).
#define HOOK_PIPE L"CaptureHook_Pipe"

#pragma pack(push, 8)

struct hook_d3d8_offsets {
    uint32_t present;
};

struct hook_d3d9_offsets {
    uint32_t present;
    uint32_t present_ex;
    uint32_t present_swap;
    uint32_t d3d9_clsoff;
    uint32_t is_d3d9ex_clsoff;
};

struct hook_d3d12_offsets {
    uint32_t execute_command_lists;
};

struct hook_dxgi_offsets {
    uint32_t present;
    uint32_t resize;
    uint32_t present1;
};

struct hook_dxgi_offsets2 {
    uint32_t release;
};

struct hook_ddraw_offsets {
    uint32_t surface_create;
    uint32_t surface_restore;
    uint32_t surface_release;
    uint32_t surface_unlock;
    uint32_t surface_blt;
    uint32_t surface_flip;
    uint32_t surface_set_palette;
    uint32_t palette_set_entries;
};

// What the texture block holds when the hook copies frames to memory (type MEMORY): which of
// the two buffers is newest, and where each starts in the block.
struct hook_shmem_data {
    volatile int last_tex;
    uint32_t tex1_offset;
    uint32_t tex2_offset;
};

// ...and when it shares a texture (type TEXTURE): a legacy (non-NT) D3D11 shared handle.
struct hook_shtex_data {
    uint32_t tex_handle;
};

enum hook_capture_type : uint32_t {
    HOOK_CAPTURE_MEMORY = 0,
    HOOK_CAPTURE_TEXTURE = 1,
};

struct hook_graphics_offsets {
    struct hook_d3d8_offsets d3d8;
    struct hook_d3d9_offsets d3d9;
    struct hook_dxgi_offsets dxgi;
    struct hook_ddraw_offsets ddraw;
    struct hook_dxgi_offsets2 dxgi2;
    struct hook_d3d12_offsets d3d12;
};

// The hook info block (CaptureHook_HookInfo<pid>), made by the hook when it loads: we fill in
// the options and offsets before signalling Initialize, and it fills in what it captures.
struct hook_info {
    uint32_t hook_ver_major;
    uint32_t hook_ver_minor;

    enum hook_capture_type type;
    uint32_t window;
    uint32_t format; // a DXGI_FORMAT
    uint32_t cx;
    uint32_t cy;
    uint32_t unused_base_cx;
    uint32_t unused_base_cy;
    uint32_t pitch;
    uint32_t map_id;
    uint32_t map_size;
    bool flip;

    uint64_t frame_interval; // nanoseconds between captured frames, 0 = every frame
    bool unused_use_scale;
    bool force_shmem;
    bool capture_overlay;
    bool allow_srgb_alias;

    struct hook_graphics_offsets offsets;

    uint32_t reserved[126];
};

#pragma pack(pop)

static_assert(sizeof(struct hook_graphics_offsets) == 76, "hook offsets layout");
static_assert(sizeof(struct hook_info) == 648, "hook info layout (OBS graphics-hook-info.h ABI)");
static_assert(sizeof(struct hook_shmem_data) == 12, "hook shared memory layout");
