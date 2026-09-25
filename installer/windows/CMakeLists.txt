cmake_minimum_required(VERSION 3.21)

project(ehbrowser-installer LANGUAGES CXX)

if(NOT CMAKE_CONFIGURATION_TYPES AND NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "构建类型")
    set_property(CACHE CMAKE_BUILD_TYPE PROPERTY STRINGS Debug Release RelWithDebInfo MinSizeRel)
endif()

set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

add_executable(ehbrowser-installer main.cpp)

target_compile_features(ehbrowser-installer PRIVATE cxx_std_20)

if(MSVC)
    target_compile_options(ehbrowser-installer PRIVATE
        /utf-8
        /W4
        /permissive-
        $<$<CONFIG:Release>:/guard:cf>)
    target_link_options(ehbrowser-installer PRIVATE $<$<CONFIG:Release>:/GUARD:CF>)
else()
    target_compile_options(ehbrowser-installer PRIVATE -Wall -Wextra)
endif()

include(CheckIPOSupported)
check_ipo_supported(RESULT ehbrowser_ipo_supported OUTPUT ehbrowser_ipo_message LANGUAGES CXX)
if(ehbrowser_ipo_supported)
    set_target_properties(ehbrowser-installer PROPERTIES INTERPROCEDURAL_OPTIMIZATION_RELEASE TRUE)
else()
    message(STATUS "跳过 LTCG：${ehbrowser_ipo_message}")
endif()

target_link_libraries(ehbrowser-installer PRIVATE winhttp shell32 advapi32)

set_target_properties(ehbrowser-installer PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
