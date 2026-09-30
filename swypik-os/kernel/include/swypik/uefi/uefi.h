#ifndef SWYPIK_UEFI_H
#define SWYPIK_UEFI_H

#include <stdint.h>

#if defined(__GNUC__) && defined(__x86_64__)
#define SWYP_EFIAPI __attribute__((ms_abi))
#else
#define SWYP_EFIAPI
#endif

typedef uint8_t EFI_BOOLEAN;
typedef uint16_t EFI_CHAR16;
typedef uint32_t EFI_UINT32;
typedef uint64_t EFI_UINT64;
typedef uint64_t EFI_UINTN;
typedef uint64_t EFI_STATUS;
typedef void *EFI_HANDLE;

#define EFI_SUCCESS UINT64_C(0)
#define EFI_ERROR_MASK UINT64_C(0x8000000000000000)
#define EFIERR(code) (EFI_ERROR_MASK | (uint64_t)(code))
#define EFI_BUFFER_TOO_SMALL EFIERR(5)
#define EFI_DEVICE_ERROR EFIERR(7)

typedef struct EFI_TABLE_HEADER {
    EFI_UINT64 Signature;
    EFI_UINT32 Revision;
    EFI_UINT32 HeaderSize;
    EFI_UINT32 CRC32;
    EFI_UINT32 Reserved;
} EFI_TABLE_HEADER;

typedef struct EFI_SIMPLE_TEXT_OUTPUT_PROTOCOL EFI_SIMPLE_TEXT_OUTPUT_PROTOCOL;
typedef EFI_STATUS(SWYP_EFIAPI *EFI_TEXT_RESET)(EFI_SIMPLE_TEXT_OUTPUT_PROTOCOL *This, EFI_BOOLEAN ExtendedVerification);
typedef EFI_STATUS(SWYP_EFIAPI *EFI_TEXT_STRING)(EFI_SIMPLE_TEXT_OUTPUT_PROTOCOL *This, const EFI_CHAR16 *String);

struct EFI_SIMPLE_TEXT_OUTPUT_PROTOCOL {
    EFI_TEXT_RESET Reset;
    EFI_TEXT_STRING OutputString;
    void *TestString;
    void *QueryMode;
    void *SetMode;
    void *SetAttribute;
    void *ClearScreen;
    void *SetCursorPosition;
    void *EnableCursor;
    void *Mode;
};

typedef struct EFI_MEMORY_DESCRIPTOR {
    EFI_UINT32 Type;
    EFI_UINT32 Pad;
    EFI_UINT64 PhysicalStart;
    EFI_UINT64 VirtualStart;
    EFI_UINT64 NumberOfPages;
    EFI_UINT64 Attribute;
} EFI_MEMORY_DESCRIPTOR;

typedef EFI_STATUS(SWYP_EFIAPI *EFI_GET_MEMORY_MAP)(EFI_UINTN *MemoryMapSize, EFI_MEMORY_DESCRIPTOR *MemoryMap,
                                                     EFI_UINTN *MapKey, EFI_UINTN *DescriptorSize,
                                                     EFI_UINT32 *DescriptorVersion);

typedef struct EFI_BOOT_SERVICES {
    EFI_TABLE_HEADER Hdr;
    void *RaiseTPL;
    void *RestoreTPL;
    void *AllocatePages;
    void *FreePages;
    EFI_GET_MEMORY_MAP GetMemoryMap;
} EFI_BOOT_SERVICES;

typedef struct EFI_SYSTEM_TABLE {
    EFI_TABLE_HEADER Hdr;
    EFI_CHAR16 *FirmwareVendor;
    EFI_UINT32 FirmwareRevision;
    EFI_UINT32 Pad;
    EFI_HANDLE ConsoleInHandle;
    void *ConIn;
    EFI_HANDLE ConsoleOutHandle;
    EFI_SIMPLE_TEXT_OUTPUT_PROTOCOL *ConOut;
    EFI_HANDLE StandardErrorHandle;
    EFI_SIMPLE_TEXT_OUTPUT_PROTOCOL *StdErr;
    void *RuntimeServices;
    EFI_BOOT_SERVICES *BootServices;
    EFI_UINTN NumberOfTableEntries;
    void *ConfigurationTable;
} EFI_SYSTEM_TABLE;

#endif
