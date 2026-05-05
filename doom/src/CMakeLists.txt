foreach(SUBDIR doom)
    add_subdirectory("${SUBDIR}")
endforeach()

# Common source files used by absolutely everything:

set(COMMON_SOURCE_FILES
    i_main.c
    i_system.c           i_system.h
    m_argv.c             m_argv.h
    m_misc.c             m_misc.h)

# Doom-wasm: Set up SDL flags. Server, setup, heretic/hexen/strife targets
# have all been removed; we build just chocolate-doom.
if (DEFINED EMSCRIPTEN)
    set(SDL_FLAGS "-s USE_SDL=2")
    if(ENABLE_SDL2_MIXER)
        set(SDL_FLAGS "${SDL_FLAGS} -s USE_SDL_MIXER=2")
    endif()
    if(ENABLE_SDL2_NET)
        set(SDL_FLAGS "${SDL_FLAGS} -s USE_SDL_NET=2")
    endif()
else()
    set(SDL_LINK_LIBS SDL2::SDL2main SDL2::SDL2)
    if(ENABLE_SDL2_MIXER)
        list(APPEND SDL_LINK_LIBS SDL2_mixer::SDL2_mixer)
    endif()
    if(ENABLE_SDL2_NET)
        list(APPEND SDL_LINK_LIBS SDL2_net::SDL2_net)
    endif()
endif()

# Source files used by the game binaries (chocolate-doom).
#
# Doom-wasm replaces SDL2_net with the WebSocket-based net_websockets module,
# so net_sdl.c is excluded from the build (its symbols would also be #ifdef-ed
# out by DISABLE_SDL2NET).

set(GAME_SOURCE_FILES
    aes_prng.c          aes_prng.h
    d_event.c           d_event.h
                        doomkeys.h
                        doomtype.h
    d_iwad.c            d_iwad.h
    d_loop.c            d_loop.h
    d_mode.c            d_mode.h
                        d_ticcmd.h
    deh_str.c           deh_str.h
    gusconf.c           gusconf.h
    i_cdmus.c           i_cdmus.h
    i_endoom.c          i_endoom.h
    i_flmusic.c
    i_glob.c            i_glob.h
    i_input.c           i_input.h
    i_joystick.c        i_joystick.h
                        i_swap.h
    i_musicpack.c
    i_oplmusic.c
    i_pcsound.c
    i_sdlmusic.c
    i_sdlsound.c
    i_sound.c           i_sound.h
    i_timer.c           i_timer.h
    i_video.c           i_video.h
    i_videohr.c         i_videohr.h
    i_winmusic.c
    midifallback.c      midifallback.h
    midifile.c          midifile.h
    mus2mid.c           mus2mid.h
    m_bbox.c            m_bbox.h
    m_cheat.c           m_cheat.h
    m_config.c          m_config.h
    m_controls.c        m_controls.h
    m_fixed.c           m_fixed.h
    net_client.c        net_client.h
    net_common.c        net_common.h
    net_dedicated.c     net_dedicated.h
    net_defs.h
    net_gui.c           net_gui.h
    net_io.c            net_io.h
    net_loop.c          net_loop.h
    net_packet.c        net_packet.h
    net_petname.c       net_petname.h
    net_query.c         net_query.h
    net_server.c        net_server.h
    net_structrw.c      net_structrw.h
    net_websockets.c    net_websockets.h
    p_rejectpad.c       p_rejectpad.h
    sha1.c              sha1.h
    memio.c             memio.h
    tables.c            tables.h
    v_diskicon.c        v_diskicon.h
    v_video.c           v_video.h
                        v_patch.h
    w_checksum.c        w_checksum.h
    w_main.c            w_main.h
    w_wad.c             w_wad.h
    w_file.c            w_file.h
    w_file_stdc.c
    w_file_posix.c
    w_file_win32.c
    w_merge.c           w_merge.h
    z_zone.c            z_zone.h)

set(GAME_INCLUDE_DIRS "${CMAKE_CURRENT_BINARY_DIR}/../")

if(WIN32)
    list(APPEND GAME_SOURCE_FILES
         "../win32/win_opendir.c" "../win32/win_opendir.h")

    list(APPEND GAME_INCLUDE_DIRS
         "${PROJECT_SOURCE_DIR}/win32/")
endif()

set(DEHACKED_SOURCE_FILES
    deh_defs.h
    deh_io.c            deh_io.h
    deh_main.c          deh_main.h
    deh_mapping.c       deh_mapping.h
    deh_text.c)

set(SOURCE_FILES ${COMMON_SOURCE_FILES} ${GAME_SOURCE_FILES})
set(SOURCE_FILES_WITH_DEH ${SOURCE_FILES} ${DEHACKED_SOURCE_FILES})

set(EXTRA_LIBS ${SDL_LINK_LIBS} textscreen pcsound opl)
if(SampleRate_FOUND)
    list(APPEND EXTRA_LIBS SampleRate::samplerate)
endif()
if(PNG_FOUND)
    list(APPEND EXTRA_LIBS PNG::PNG)
endif()
if(FluidSynth_FOUND)
    list(APPEND EXTRA_LIBS FluidSynth::libfluidsynth)
endif()
if(WIN32)
    list(APPEND EXTRA_LIBS winmm shlwapi)
endif()

if(WIN32)
    add_executable("${PROGRAM_PREFIX}doom" WIN32 ${SOURCE_FILES_WITH_DEH} "${CMAKE_CURRENT_BINARY_DIR}/doom-res.rc")
else()
    add_executable("${PROGRAM_PREFIX}doom" ${SOURCE_FILES_WITH_DEH})
endif()

target_include_directories("${PROGRAM_PREFIX}doom" PRIVATE ${GAME_INCLUDE_DIRS})
target_link_libraries("${PROGRAM_PREFIX}doom" doom ${EXTRA_LIBS})
set_target_properties("${PROGRAM_PREFIX}doom" PROPERTIES COMPILE_FLAGS "${SDL_FLAGS}")

if(MSVC)
    set_target_properties("${PROGRAM_PREFIX}doom" PROPERTIES
                          LINK_FLAGS "/MANIFEST:NO")
endif()

if (DEFINED EMSCRIPTEN)
    # Doom-wasm Emscripten link flags:
    #   USE_SDL=2 / USE_SDL_MIXER=2  - matches compile flags
    #   ALLOW_MEMORY_GROWTH=1        - heap can grow at runtime
    #   INITIAL_MEMORY=64MB          - large enough to load typical IWADs
    #   ASYNCIFY=1                   - lets emscripten_sleep() / OPL_Delay()
    #                                  yield back to the browser event loop
    #   EXIT_RUNTIME=1               - flush stdout/stderr on quit
    #   ASSERTIONS=0                 - production sized
    #   STACK_OVERFLOW_CHECK=1       - guard band the stack
    #   ERROR_ON_UNDEFINED_SYMBOLS=0 - tolerate emscripten-stubbed POSIX bits
    #   FORCE_FILESYSTEM=1           - keep MEMFS available even when no
    #                                  preloaded files are referenced from C
    #   EXPORTED_*                   - what the host page calls into
    #   -lwebsocket.js               - emscripten WebSocket polyfill (used
    #                                  by net_websockets.c)
    #   -gsource-map / --source-map-base /  - emit a wasm sourcemap
    #   -O3                          - override the project-wide -O2 default
    set(EM_LINK_FLAGS "${SDL_FLAGS} -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=64MB -s ASYNCIFY=1 -s EXIT_RUNTIME=1 -s ASSERTIONS=0 -s STACK_OVERFLOW_CHECK=1 -s ERROR_ON_UNDEFINED_SYMBOLS=0 -s FORCE_FILESYSTEM=1 -s EXPORTED_RUNTIME_METHODS=ccall,cwrap,FS,ENV,PATH,ERRNO_CODES,callMain -s EXPORTED_FUNCTIONS=_main -lwebsocket.js -O3 -gsource-map --source-map-base /")
    set_target_properties("${PROGRAM_PREFIX}doom" PROPERTIES LINK_FLAGS "${EM_LINK_FLAGS}")
endif()
