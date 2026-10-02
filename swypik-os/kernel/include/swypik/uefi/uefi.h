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
typedef uint64_t EFI_PHYSICAL_ADDRESS;
typedef uint64_t EFI_STATUS;
typedef void *EFI_HANDLE;

typedef struct EFI_GUID {
    uint32_t Data1;
    uint16_t Data2;
    uint16_t Data3;
    uint8_t Data4[8];
} EFI_GUID;

typedef struct EFI_CONFIGURATION_TABLE {
    EFI_GUID VendorGuid;
    void *VendorTable;
} EFI_CONFIGURATION_TABLE;

#define EFI_SUCCESS UINT64_C(0)
#define EFI_ERROR_MASK UINT64_C(0x8000000000000000)
#define EFIERR(code) (EFI_ERROR_MASK | (uint64_t)(code))
#define EFI_INVALID_PARAMETER EFIERR(2)
#define EFI_BUFFER_TOO_SMALL EFIERR(5)
#define EFI_DEVICE_ERROR EFIERR(7)

typedef enum EFI_MEMORY_TYPE {
    EfiReservedMemoryType = 0,
    EfiLoaderCode = 1,
    EfiLoaderData = 2,
    EfiBootServicesCode = 3,
    EfiBootServicesData = 4,
    EfiRuntimeServicesCode = 5,
    EfiRuntimeServicesData = 6,
    EfiConventionalMemory = 7,
    EfiUnusableMemory = 8,
    EfiACPIReclaimMemory = 9,
    EfiACPIMemoryNVS = 10,
    EfiMemoryMappedIO = 11,
    EfiMemoryMappedIOPortSpace = 12,
    EfiPalCode = 13,
    EfiPersistentMemory = 14,
    EfiUnacceptedMemoryType = 15
} EFI_MEMORY_TYPE;

typedef enum EFI_ALLOCATE_TYPE {
    AllocateAnyPages = 0,
    AllocateMaxAddress = 1,
    AllocateAddress = 2,
    MaxAllocateType = 3
} EFI_ALLOCATE_TYPE;

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
typedef EFI_STATUS(SWYP_EFIAPI *EFI_ALLOCATE_PAGES)(EFI_ALLOCATE_TYPE Type, EFI_MEMORY_TYPE MemoryType,
                                                     EFI_UINTN Pages, EFI_PHYSICAL_ADDRESS *Memory);
typedef EFI_STATUS(SWYP_EFIAPI *EFI_FREE_PAGES)(EFI_PHYSICAL_ADDRESS Memory, EFI_UINTN Pages);
typedef EFI_STATUS(SWYP_EFIAPI *EFI_HANDLE_PROTOCOL)(EFI_HANDLE Handle, const EFI_GUID *Protocol, void **Interface);
typedef EFI_STATUS(SWYP_EFIAPI *EFI_EXIT_BOOT_SERVICES)(EFI_HANDLE ImageHandle, EFI_UINTN MapKey);

typedef struct EFI_LOADED_IMAGE_PROTOCOL {
    EFI_UINT32 Revision;
    EFI_HANDLE ParentHandle;
    void *SystemTable;
    EFI_HANDLE DeviceHandle;
    void *FilePath;
    void *Reserved;
    EFI_UINT32 LoadOptionsSize;
    void *LoadOptions;
    void *ImageBase;
    EFI_UINT64 ImageSize;
    EFI_MEMORY_TYPE ImageCodeType;
    EFI_MEMORY_TYPE ImageDataType;
    void *Unload;
} EFI_LOADED_IMAGE_PROTOCOL;

typedef struct EFI_BOOT_SERVICES {
    EFI_TABLE_HEADER Hdr;
    void *RaiseTPL;
    void *RestoreTPL;
    EFI_ALLOCATE_PAGES AllocatePages;
    EFI_FREE_PAGES FreePages;
    EFI_GET_MEMORY_MAP GetMemoryMap;
    void *AllocatePool;
    void *FreePool;
    void *CreateEvent;
    void *SetTimer;
    void *WaitForEvent;
    void *SignalEvent;
    void *CloseEvent;
    void *CheckEvent;
    void *InstallProtocolInterface;
    void *ReinstallProtocolInterface;
    void *UninstallProtocolInterface;
    EFI_HANDLE_PROTOCOL HandleProtocol;
    void *Reserved;
    void *RegisterProtocolNotify;
    void *LocateHandle;
    void *LocateDevicePath;
    void *InstallConfigurationTable;
    void *LoadImage;
    void *StartImage;
    void *Exit;
    void *UnloadImage;
    EFI_EXIT_BOOT_SERVICES ExitBootServices;
    void *GetNextMonotonicCount;
    void *Stall;
    void *SetWatchdogTimer;
    void *ConnectController;
    void *DisconnectController;
    void *OpenProtocol;
    void *CloseProtocol;
    void *OpenProtocolInformation;
    void *ProtocolsPerHandle;
    void *LocateHandleBuffer;
    void *LocateProtocol;
    void *InstallMultipleProtocolInterfaces;
    void *UninstallMultipleProtocolInterfaces;
    void *CalculateCrc32;
    void *CopyMem;
    void *SetMem;
    void *CreateEventEx;
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
    EFI_CONFIGURATION_TABLE *ConfigurationTable;
} EFI_SYSTEM_TABLE;

#endif
