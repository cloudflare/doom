//
// Copyright(C) 2005-2014 Simon Howard
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// DESCRIPTION:
//     OPL interface.
//

#include "config.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "SDL.h"

#include "opl.h"
#include "opl_internal.h"

//#define OPL_DEBUG_TRACE

// Note: modern emcc only predefines __EMSCRIPTEN__, not the bare EMSCRIPTEN
// macro that older Chocolate Doom code was guarding on. The historical "OPL
// music deadlock fix when running under Emscripten" referenced in the
// project README never actually compiled before this guard was renamed.
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif


static opl_driver_t *drivers[] =
{
#if (defined(__i386__) || defined(__x86_64__)) && defined(HAVE_IOPERM)
    &opl_linux_driver,
#endif
#if defined(HAVE_LIBI386) || defined(HAVE_LIBAMD64)
    &opl_openbsd_driver,
#endif
#ifdef _WIN32
    &opl_win32_driver,
#endif
#ifndef DISABLE_SDL2MIXER
    &opl_sdl_driver,
#endif // DISABLE_SDL2MIXER
    NULL
};

static opl_driver_t *driver = NULL;
static int init_stage_reg_writes = 1;

unsigned int opl_sample_rate = 22050;

//
// Init/shutdown code.
//

// Initialize the specified driver and detect an OPL chip.  Returns
// true if an OPL is detected.

static opl_init_result_t InitDriver(opl_driver_t *_driver,
                                    unsigned int port_base)
{
    opl_init_result_t result1, result2;

    // Initialize the driver.

    if (!_driver->init_func(port_base))
    {
        return OPL_INIT_NONE;
    }

    // The driver was initialized okay, so we now have somewhere
    // to write to.  It doesn't mean there's an OPL chip there,
    // though.  Perform the detection sequence to make sure.
    // (it's done twice, like how Doom does it).

    driver = _driver;
    init_stage_reg_writes = 1;

    result1 = OPL_Detect();
    result2 = OPL_Detect();
    if (result1 == OPL_INIT_NONE || result2 == OPL_INIT_NONE)
    {
        printf("OPL_Init: No OPL detected using '%s' driver.\n", _driver->name);
        _driver->shutdown_func();
        driver = NULL;
        return OPL_INIT_NONE;
    }

    init_stage_reg_writes = 0;

    printf("OPL_Init: Using driver '%s'.\n", driver->name);

    return result2;
}

// Find a driver automatically by trying each in the list.

static opl_init_result_t AutoSelectDriver(unsigned int port_base)
{
    int i;
    opl_init_result_t result;

    for (i = 0; drivers[i] != NULL; ++i)
    {
        result = InitDriver(drivers[i], port_base);
        if (result != OPL_INIT_NONE)
        {
            return result;
        }
    }

    printf("OPL_Init: Failed to find a working driver.\n");

    return OPL_INIT_NONE;
}

// Initialize the OPL library. Return value indicates type of OPL chip
// detected, if any.

opl_init_result_t OPL_Init(unsigned int port_base)
{
    char *driver_name;
    int i;
    int result;

    driver_name = getenv("OPL_DRIVER");

    if (driver_name != NULL)
    {
        // Search the list until we find the driver with this name.

        for (i=0; drivers[i] != NULL; ++i)
        {
            if (!strcmp(driver_name, drivers[i]->name))
            {
                result = InitDriver(drivers[i], port_base);
                if (result)
                {
                    return result;
                }
                else
                {
                    printf("OPL_Init: Failed to initialize "
                           "driver: '%s'.\n", driver_name);
                    return OPL_INIT_NONE;
                }
            }
        }

        printf("OPL_Init: unknown driver: '%s'.\n", driver_name);

        return OPL_INIT_NONE;
    }
    else
    {
        return AutoSelectDriver(port_base);
    }
}

// Shut down the OPL library.

void OPL_Shutdown(void)
{
    if (driver != NULL)
    {
        driver->shutdown_func();
        driver = NULL;
    }
}

// Set the sample rate used for software OPL emulation.

void OPL_SetSampleRate(unsigned int rate)
{
    opl_sample_rate = rate;
}

void OPL_WritePort(opl_port_t port, unsigned int value)
{
    if (driver != NULL)
    {
#ifdef OPL_DEBUG_TRACE
        printf("OPL_write: %i, %x\n", port, value);
        fflush(stdout);
#endif
        driver->write_port_func(port, value);
    }
}

unsigned int OPL_ReadPort(opl_port_t port)
{
    if (driver != NULL)
    {
        unsigned int result;

#ifdef OPL_DEBUG_TRACE
        printf("OPL_read: %i...\n", port);
        fflush(stdout);
#endif

        result = driver->read_port_func(port);

#ifdef OPL_DEBUG_TRACE
        printf("OPL_read: %i -> %x\n", port, result);
        fflush(stdout);
#endif

        return result;
    }
    else
    {
        return 0;
    }
}

//
// Higher-level functions, based on the lower-level functions above
// (register write, etc).
//

unsigned int OPL_ReadStatus(void)
{
    return OPL_ReadPort(OPL_REGISTER_PORT);
}

// Write an OPL register value

void OPL_WriteRegister(int reg, int value)
{
    int i;

    if (reg & 0x100)
    {
        OPL_WritePort(OPL_REGISTER_PORT_OPL3, reg);
    }
    else
    {
        OPL_WritePort(OPL_REGISTER_PORT, reg);
    }

    // For timing, read the register port six times after writing the
    // register number to cause the appropriate delay

    for (i=0; i<6; ++i)
    {
        // An oddity of the Doom OPL code: at startup initialization,
        // the spacing here is performed by reading from the register
        // port; after initialization, the data port is read, instead.

        if (init_stage_reg_writes)
        {
            OPL_ReadPort(OPL_REGISTER_PORT);
        }
        else
        {
            OPL_ReadPort(OPL_DATA_PORT);
        }
    }

    OPL_WritePort(OPL_DATA_PORT, value);

    // Read the register port 24 times after writing the value to
    // cause the appropriate delay

    for (i=0; i<24; ++i)
    {
        OPL_ReadStatus();
    }
}

// Detect the presence of an OPL chip

opl_init_result_t OPL_Detect(void)
{
    int result1, result2;
    int i;

    // Reset both timers:
    OPL_WriteRegister(OPL_REG_TIMER_CTRL, 0x60);

    // Enable interrupts:
    OPL_WriteRegister(OPL_REG_TIMER_CTRL, 0x80);

    // Read status
    result1 = OPL_ReadStatus();

    // Set timer:
    OPL_WriteRegister(OPL_REG_TIMER1, 0xff);

    // Start timer 1:
    OPL_WriteRegister(OPL_REG_TIMER_CTRL, 0x21);

    // Wait for 80 microseconds
    // This is how Doom does it:

    for (i=0; i<200; ++i)
    {
        OPL_ReadStatus();
    }

    OPL_Delay(1 * OPL_MS);

    // Read status
    result2 = OPL_ReadStatus();

    // Reset both timers:
    OPL_WriteRegister(OPL_REG_TIMER_CTRL, 0x60);

    // Enable interrupts:
    OPL_WriteRegister(OPL_REG_TIMER_CTRL, 0x80);

    if ((result1 & 0xe0) == 0x00 && (result2 & 0xe0) == 0xc0)
    {
        result1 = OPL_ReadPort(OPL_REGISTER_PORT);
        result2 = OPL_ReadPort(OPL_REGISTER_PORT_OPL3);
        if (result1 == 0x00)
        {
            return OPL_INIT_OPL3;
        }
        else
        {
            return OPL_INIT_OPL2;
        }
    }
    else
    {
        return OPL_INIT_NONE;
    }
}

// Initialize registers on startup

void OPL_InitRegisters(int opl3)
{
    int r;

    // Initialize level registers

    for (r=OPL_REGS_LEVEL; r <= OPL_REGS_LEVEL + OPL_NUM_OPERATORS; ++r)
    {
        OPL_WriteRegister(r, 0x3f);
    }

    // Initialize other registers
    // These two loops write to registers that actually don't exist,
    // but this is what Doom does ...
    // Similarly, the <= is also intenational.

    for (r=OPL_REGS_ATTACK; r <= OPL_REGS_WAVEFORM + OPL_NUM_OPERATORS; ++r)
    {
        OPL_WriteRegister(r, 0x00);
    }

    // More registers ...

    for (r=1; r < OPL_REGS_LEVEL; ++r)
    {
        OPL_WriteRegister(r, 0x00);
    }

    // Re-initialize the low registers:

    // Reset both timers and enable interrupts:
    OPL_WriteRegister(OPL_REG_TIMER_CTRL,      0x60);
    OPL_WriteRegister(OPL_REG_TIMER_CTRL,      0x80);

    // "Allow FM chips to control the waveform of each operator":
    OPL_WriteRegister(OPL_REG_WAVEFORM_ENABLE, 0x20);

    if (opl3)
    {
        OPL_WriteRegister(OPL_REG_NEW, 0x01);

        // Initialize level registers

        for (r=OPL_REGS_LEVEL; r <= OPL_REGS_LEVEL + OPL_NUM_OPERATORS; ++r)
        {
            OPL_WriteRegister(r | 0x100, 0x3f);
        }

        // Initialize other registers
        // These two loops write to registers that actually don't exist,
        // but this is what Doom does ...
        // Similarly, the <= is also intenational.

        for (r=OPL_REGS_ATTACK; r <= OPL_REGS_WAVEFORM + OPL_NUM_OPERATORS; ++r)
        {
            OPL_WriteRegister(r | 0x100, 0x00);
        }

        // More registers ...

        for (r=1; r < OPL_REGS_LEVEL; ++r)
        {
            OPL_WriteRegister(r | 0x100, 0x00);
        }
    }

    // Keyboard split point on (?)
    OPL_WriteRegister(OPL_REG_FM_MODE,         0x40);

    if (opl3)
    {
        OPL_WriteRegister(OPL_REG_NEW, 0x01);
    }
}

//
// Timer functions.
//

void OPL_SetCallback(uint64_t us, opl_callback_t callback, void *data)
{
    if (driver != NULL)
    {
        driver->set_callback_func(us, callback, data);
    }
}

void OPL_ClearCallbacks(void)
{
    if (driver != NULL)
    {
        driver->clear_callbacks_func();
    }
}

void OPL_Lock(void)
{
    if (driver != NULL)
    {
        driver->lock_func();
    }
}

void OPL_Unlock(void)
{
    if (driver != NULL)
    {
        driver->unlock_func();
    }
}

typedef struct
{
    int finished;

    SDL_mutex *mutex;
    SDL_cond *cond;
} delay_data_t;

static void DelayCallback(void *_delay_data)
{
    delay_data_t *delay_data = _delay_data;

    SDL_LockMutex(delay_data->mutex);
    delay_data->finished = 1;

    SDL_CondSignal(delay_data->cond);

    SDL_UnlockMutex(delay_data->mutex);
}

// Delay for specified number of microseconds after OPL subsystem is initialized

void OPL_Delay(uint64_t us)
{
    delay_data_t delay_data;

    if (driver == NULL)
    {
        return;
    }

    // Create a callback that will signal this thread after the
    // specified time.

    // Note that this is not just a simple time-based delay, it will ensure
    // that the OPL system is initialized and the queue has begun processing
    // before releasing the mutex lock

    delay_data.finished = 0;
    delay_data.mutex = SDL_CreateMutex();
    delay_data.cond = SDL_CreateCond();

    OPL_SetCallback(us, DelayCallback, &delay_data);

    // Wait until the callback is invoked.

    SDL_LockMutex(delay_data.mutex);

#ifdef __EMSCRIPTEN__
    // Doom-wasm: SDL_CondWait would block forever on Emscripten's single-
    // threaded SDL2 build -- there's no audio thread to signal the cond, and
    // the Mix_RegisterEffect postmix that's supposed to fire DelayCallback
    // only runs while the implicit Web Audio context is unsuspended. The
    // previous "fix" called SDL_CondWait *then* emscripten_sleep, but control
    // never returned from the cond wait so the asyncify yield was unreachable
    // and the entire main loop froze before emscripten_set_main_loop was
    // even registered (this is what -nomusic was silently working around).
    // The historical fix also keyed off the bare EMSCRIPTEN macro, which
    // modern emcc no longer predefines (it now only sets __EMSCRIPTEN__) --
    // so the fix sat in the tree as dead code for ages.
    //
    // Drop the mutex, yield to the browser event loop via emscripten_sleep,
    // and re-acquire on the next iteration. The browser pumps Web Audio
    // during the sleep; one SDL_mixer audio buffer (1024 samples @ 22050Hz
    // ~= 46 ms) advances the OPL emulator clock by far more than the 1 ms
    // requested by OPL_Detect, so DelayCallback typically fires after a
    // single iteration. The iteration cap is a safety net for the case
    // where the AudioContext remains suspended (browser autoplay policy):
    // we eventually fall through with delay_data.finished still false,
    // OPL_Detect will report no chip, and music degrades to silent rather
    // than hanging the page. The native build keeps the original cond_wait.
    //
    // 200 iterations * emscripten_sleep(1) is at most ~200 ms of wall time
    // when timer granularity is honoured, and a few seconds in worst-case
    // browsers; either way, finite.
    {
        int opl_delay_iters = 0;
        const int opl_delay_max = 200;
        while (!delay_data.finished && opl_delay_iters++ < opl_delay_max)
        {
            SDL_UnlockMutex(delay_data.mutex);
            emscripten_sleep(1);
            SDL_LockMutex(delay_data.mutex);
        }
    }
#else
    while (!delay_data.finished)
    {
        SDL_CondWait(delay_data.cond, delay_data.mutex);
    }
#endif

    SDL_UnlockMutex(delay_data.mutex);

    // Clean up.

    SDL_DestroyMutex(delay_data.mutex);
    SDL_DestroyCond(delay_data.cond);
}

void OPL_SetPaused(int paused)
{
    if (driver != NULL)
    {
        driver->set_paused_func(paused);
    }
}

void OPL_AdjustCallbacks(float value)
{
    if (driver != NULL)
    {
        driver->adjust_callbacks_func(value);
    }
}

