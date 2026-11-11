# voicaw-capture.exe (Game capture in docs/desktop-and-site.md), built with MSVC on GitHub's
# Windows runner by .github/workflows/desktop-release.yml:
#   cmake -S electron/game-capture/helper -B build/capture -A x64
#   cmake --build build/capture --config Release
# On Linux, electron/game-capture/build-helper.sh cross-compiles the same file with MinGW.
cmake_minimum_required(VERSION 3.20)
project(voicaw_capture CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# No runtime DLLs to ship beside it.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

add_executable(voicaw-capture voicaw-capture.cpp hook-protocol.h)
target_compile_definitions(voicaw-capture PRIVATE UNICODE _UNICODE _CRT_SECURE_NO_WARNINGS)
target_link_libraries(voicaw-capture PRIVATE d3d11 dxgi winmm shell32 user32)
if(MSVC)
    target_compile_options(voicaw-capture PRIVATE /W4 /permissive-)
    target_link_options(voicaw-capture PRIVATE /SUBSYSTEM:CONSOLE)
endif()
