cmake_minimum_required(VERSION 3.21)

project(ehbrowser-installer LANGUAGES CXX)

if(NOT CMAKE_CONFIGURATION_TYPES AND NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "构建类型")
    set_property(CACHE CMAKE_BUILD_TYPE PROPERTY STRINGS Debug Release RelWithDebInfo MinSizeRel)
endif()

set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

# 资源类型宏 RT_RCDATA 之类走的是 MAKEINTRESOURCE，UNICODE 未定义时会展开成窄字符版本，
# 传给 FindResourceW 直接编译不过。程序里本来就用的是显式的 ...W，这里声明成 Unicode 版本
add_compile_definitions(UNICODE _UNICODE)

# 资源脚本只在 Windows 上编（非 Windows 时连 main.cpp 都编不过，这里只是别让 configure 阶段就炸）
if(WIN32)
    enable_language(RC)
endif()

# 两个可执行文件：
#   ehbrowser-installer  控制台程序，交互式安装
#   ehbrowser-launcher   GUI 子系统、没有控制台窗口，给桌面/开始菜单快捷方式用（见 launcher.cpp）
add_executable(ehbrowser-installer main.cpp)
add_executable(ehbrowser-launcher WIN32 launcher.cpp)

target_compile_features(ehbrowser-installer PRIVATE cxx_std_20)
target_compile_features(ehbrowser-launcher PRIVATE cxx_std_20)

# 安装器只支持 Windows 10 及以上；显式声明目标版本，SHGetKnownFolderPath 之类的 API 才可见
target_compile_definitions(ehbrowser-installer PRIVATE _WIN32_WINNT=0x0A00)

foreach(target IN ITEMS ehbrowser-installer ehbrowser-launcher)
    if(MSVC)
        target_compile_options(${target} PRIVATE
            /utf-8
            /W4
            /permissive-
            $<$<CONFIG:Release>:/guard:cf>)
        target_link_options(${target} PRIVATE $<$<CONFIG:Release>:/GUARD:CF>)
    else()
        target_compile_options(${target} PRIVATE -Wall -Wextra)
    endif()
endforeach()

include(CheckIPOSupported)
check_ipo_supported(RESULT ehbrowser_ipo_supported OUTPUT ehbrowser_ipo_message LANGUAGES CXX)
if(ehbrowser_ipo_supported)
    set_target_properties(ehbrowser-installer ehbrowser-launcher PROPERTIES
        INTERPROCEDURAL_OPTIMIZATION_RELEASE TRUE)
else()
    message(STATUS "跳过 LTCG：${ehbrowser_ipo_message}")
endif()

# uuid 本来就在 MSVC 的默认库里，这里显式写出来是因为 FOLDERID_* 与 CLSID_ShellLink 由它提供
target_link_libraries(ehbrowser-installer PRIVATE winhttp shell32 advapi32 ole32 uuid)
target_link_libraries(ehbrowser-launcher PRIVATE shell32 user32)

# 启动器的产物路径必须固定、不随配置分层：安装器在 configure 阶段就要把它写进资源脚本。
# 显式给出每个配置的输出目录，多配置生成器就不会再往里追加一层 Release/Debug。
set(EHBROWSER_LAUNCHER_DIR "${CMAKE_BINARY_DIR}/bin/launcher")
set_target_properties(ehbrowser-launcher PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${EHBROWSER_LAUNCHER_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_DEBUG "${EHBROWSER_LAUNCHER_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${EHBROWSER_LAUNCHER_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${EHBROWSER_LAUNCHER_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_MINSIZEREL "${EHBROWSER_LAUNCHER_DIR}")

set(EHBROWSER_LAUNCHER_EXE "${EHBROWSER_LAUNCHER_DIR}/ehbrowser-launcher.exe")

if(WIN32)
    # rc 把字符串里的反斜杠当转义（\x64 会被吃成 "d"，\t 会变成制表符），所以路径里的反斜杠
    # 必须写成两个。CMake 的 ${CMAKE_BINARY_DIR} 出来就是正斜杠，这步只是兜底
    string(REPLACE "\\" "\\\\" EHBROWSER_LAUNCHER_EXE_RC "${EHBROWSER_LAUNCHER_EXE}")
    string(REPLACE "\\" "\\\\" EHBROWSER_ICON_RC "${CMAKE_CURRENT_SOURCE_DIR}/ehbrowser.ico")
    # 安装器的 rc：内嵌启动器 + 自己的应用图标；启动器的 rc：只内嵌应用图标
    configure_file(installer.rc.in "${CMAKE_CURRENT_BINARY_DIR}/installer.rc" @ONLY)
    configure_file(launcher.rc.in "${CMAKE_CURRENT_BINARY_DIR}/launcher.rc" @ONLY)
    target_sources(ehbrowser-installer PRIVATE "${CMAKE_CURRENT_BINARY_DIR}/installer.rc")
    target_sources(ehbrowser-launcher PRIVATE "${CMAKE_CURRENT_BINARY_DIR}/launcher.rc")
endif()

# 编译资源脚本前必须先把启动器生成出来
add_dependencies(ehbrowser-installer ehbrowser-launcher)

set_target_properties(ehbrowser-installer PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
