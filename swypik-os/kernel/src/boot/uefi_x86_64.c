#include "swypik/kernel/contracts.h"
#include "swypik/uefi/uefi.h"

#define SWYP_UEFI_MEMORY_MAP_BYTES (128u * 1024u)

static _Alignas(16) uint8_t g_memory_map_storage[SWYP_UEFI_MEMORY_MAP_BYTES];
static SwypBootInfo g_boot_info;

static const EFI_CHAR16 kBanner[] = {
    'S','w','y','p','i','k','O','S',' ','n','a','t','i','v','e',' ','k','e','r','n','e','l',' ','s','e','e','d','\r','\n',0
};
static const EFI_CHAR16 kStage[] = {
    's','t','a','g','e','=','u','e','f','i','-','l','o','a','d','e','r',' ','a','r','c','h','=','x','8','6','_','6','4','\r','\n',0
};
static const EFI_CHAR16 kMemoryOk[] = {
    'm','e','m','o','r','y','-','m','a','p','=','o','k',' ','e','n','t','r','i','e','s','=',0
};
static const EFI_CHAR16 kMemoryFail[] = {
    'm','e','m','o','r','y','-','m','a','p','=','f','a','i','l','e','d','\r','\n',0
};
static const EFI_CHAR16 kMemoryTooLarge[] = {
    'm','e','m','o','r','y','-','m','a','p','=','t','o','o','-','l','a','r','g','e','\r','\n',0
};
static const EFI_CHAR16 kSeedOnly[] = {
    's','t','a','t','u','s','=','s','e','e','d','-','o','n','l','y',' ','n','o','-','k','e','r','n','e','l','-','h','a','n','d','o','f','f','\r','\n',0
};
static const EFI_CHAR16 kCrLf[] = {'\r','\n',0};

static EFI_STATUS swyp_print(EFI_SYSTEM_TABLE *system_table, const EFI_CHAR16 *text) {
    if (system_table == 0 || system_table->ConOut == 0 || system_table->ConOut->OutputString == 0) {
        return EFI_DEVICE_ERROR;
    }
    return system_table->ConOut->OutputString(system_table->ConOut, text);
}

static void swyp_u64_to_char16(uint64_t value, EFI_CHAR16 out[32]) {
    EFI_CHAR16 reverse[24];
    uint32_t count = 0u;
    uint32_t i;
    if (value == 0u) {
        out[0] = '0';
        out[1] = 0;
        return;
    }
    while (value != 0u && count < 24u) {
        reverse[count++] = (EFI_CHAR16)('0' + (value % 10u));
        value /= 10u;
    }
    for (i = 0u; i < count; ++i) {
        out[i] = reverse[count - i - 1u];
    }
    out[count] = 0;
}

static EFI_STATUS swyp_capture_memory_map(EFI_SYSTEM_TABLE *system_table, SwypBootInfo *boot_info) {
    EFI_UINTN map_size = (EFI_UINTN)sizeof(g_memory_map_storage);
    EFI_UINTN map_key = 0u;
    EFI_UINTN descriptor_size = 0u;
    EFI_UINT32 descriptor_version = 0u;
    EFI_STATUS status;
    if (system_table == 0 || system_table->BootServices == 0 || system_table->BootServices->GetMemoryMap == 0 ||
        boot_info == 0) {
        return EFI_DEVICE_ERROR;
    }
    status = system_table->BootServices->GetMemoryMap(&map_size, (EFI_MEMORY_DESCRIPTOR *)g_memory_map_storage,
                                                       &map_key, &descriptor_size, &descriptor_version);
    if (status != EFI_SUCCESS) {
        return status;
    }
    if (descriptor_size == 0u || descriptor_size > UINT32_MAX || map_size > UINT64_MAX) {
        return EFI_DEVICE_ERROR;
    }
    boot_info->physical_memory.source = SWYP_MEMORY_MAP_UEFI;
    boot_info->physical_memory.descriptor_version = descriptor_version;
    boot_info->physical_memory.entries_address = (uint64_t)(uintptr_t)g_memory_map_storage;
    boot_info->physical_memory.buffer_bytes = (uint64_t)map_size;
    boot_info->physical_memory.entry_stride = (uint32_t)descriptor_size;
    boot_info->physical_memory.entry_count = (uint32_t)(map_size / descriptor_size);
    boot_info->physical_memory.firmware_map_key = (uint64_t)map_key;
    return EFI_SUCCESS;
}

EFI_STATUS SWYP_EFIAPI efi_main(EFI_HANDLE image_handle, EFI_SYSTEM_TABLE *system_table) {
    EFI_STATUS status;
    EFI_CHAR16 count_text[32];
    (void)image_handle;
    swyp_boot_info_init(&g_boot_info, SWYP_ARCH_X86_64, SWYP_FIRMWARE_UEFI,
                        (uint64_t)(uintptr_t)system_table);

    status = swyp_print(system_table, kBanner);
    if (status != EFI_SUCCESS) {
        return status;
    }
    status = swyp_print(system_table, kStage);
    if (status != EFI_SUCCESS) {
        return status;
    }

    status = swyp_capture_memory_map(system_table, &g_boot_info);
    if (status == EFI_BUFFER_TOO_SMALL) {
        (void)swyp_print(system_table, kMemoryTooLarge);
        return status;
    }
    if (status != EFI_SUCCESS) {
        (void)swyp_print(system_table, kMemoryFail);
        return status;
    }

    (void)swyp_print(system_table, kMemoryOk);
    swyp_u64_to_char16(g_boot_info.physical_memory.entry_count, count_text);
    (void)swyp_print(system_table, count_text);
    (void)swyp_print(system_table, kCrLf);
    (void)swyp_print(system_table, kSeedOnly);
    return EFI_SUCCESS;
}
