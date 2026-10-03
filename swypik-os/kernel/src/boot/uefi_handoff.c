#include "swypik/boot/uefi_handoff.h"

EFI_STATUS swyp_uefi_capture_memory_map(EFI_SYSTEM_TABLE *system_table, void *storage, EFI_UINTN storage_bytes,
                                        SwypBootInfo *boot_info) {
    EFI_UINTN map_size = storage_bytes;
    EFI_UINTN map_key = 0u;
    EFI_UINTN descriptor_size = 0u;
    EFI_UINT32 descriptor_version = 0u;
    EFI_STATUS status;
    if (system_table == NULL || system_table->BootServices == NULL ||
        system_table->BootServices->GetMemoryMap == NULL || storage == NULL || storage_bytes == 0u ||
        boot_info == NULL) {
        return EFI_DEVICE_ERROR;
    }
    status = system_table->BootServices->GetMemoryMap(&map_size, (EFI_MEMORY_DESCRIPTOR *)storage, &map_key,
                                                       &descriptor_size, &descriptor_version);
    if (status != EFI_SUCCESS) {
        if (status == EFI_BUFFER_TOO_SMALL) {
            boot_info->physical_memory.buffer_bytes = (uint64_t)map_size;
        }
        return status;
    }
    if (descriptor_size < sizeof(EFI_MEMORY_DESCRIPTOR) || descriptor_size > UINT32_MAX || map_size > storage_bytes ||
        map_size % descriptor_size != 0u || map_size / descriptor_size > UINT32_MAX) {
        return EFI_DEVICE_ERROR;
    }
    boot_info->physical_memory.source = SWYP_MEMORY_MAP_UEFI;
    boot_info->physical_memory.descriptor_version = descriptor_version;
    boot_info->physical_memory.entries_address = (uint64_t)(uintptr_t)storage;
    boot_info->physical_memory.buffer_bytes = (uint64_t)map_size;
    boot_info->physical_memory.entry_stride = (uint32_t)descriptor_size;
    boot_info->physical_memory.entry_count = (uint32_t)(map_size / descriptor_size);
    boot_info->physical_memory.firmware_map_key = (uint64_t)map_key;
    return EFI_SUCCESS;
}

EFI_STATUS swyp_uefi_exit_boot_services_prepared(EFI_HANDLE image_handle, EFI_SYSTEM_TABLE *system_table,
                                                 void *storage, EFI_UINTN storage_bytes, SwypBootInfo *boot_info,
                                                 uint32_t max_attempts, SwypUefiPrepareExit prepare,
                                                 void *prepare_context) {
    uint32_t attempt;
    if (image_handle == NULL || system_table == NULL || system_table->BootServices == NULL ||
        system_table->BootServices->ExitBootServices == NULL || boot_info == NULL || max_attempts == 0u) {
        return EFI_INVALID_PARAMETER;
    }
    for (attempt = 0u; attempt < max_attempts; ++attempt) {
        EFI_STATUS status = swyp_uefi_capture_memory_map(system_table, storage, storage_bytes, boot_info);
        if (status != EFI_SUCCESS) {
            return status;
        }
        if (prepare != NULL && prepare(prepare_context, boot_info) != SWYP_OK) {
            return EFI_DEVICE_ERROR;
        }
        status = system_table->BootServices->ExitBootServices(image_handle,
                                                               (EFI_UINTN)boot_info->physical_memory.firmware_map_key);
        if (status == EFI_SUCCESS) {
            boot_info->boot_flags |= SWYP_BOOT_FLAG_EXITED_BOOT_SERVICES;
            return EFI_SUCCESS;
        }
        if (status != EFI_INVALID_PARAMETER) {
            return status;
        }
    }
    return EFI_INVALID_PARAMETER;
}

EFI_STATUS swyp_uefi_exit_boot_services(EFI_HANDLE image_handle, EFI_SYSTEM_TABLE *system_table, void *storage,
                                        EFI_UINTN storage_bytes, SwypBootInfo *boot_info, uint32_t max_attempts) {
    return swyp_uefi_exit_boot_services_prepared(image_handle, system_table, storage, storage_bytes, boot_info,
                                                 max_attempts, NULL, NULL);
}
