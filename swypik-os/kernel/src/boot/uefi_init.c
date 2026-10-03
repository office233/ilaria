#include "swypik/boot/uefi_init.h"
#include "swypik/arch/x86_64/driver_image.h"

static const EFI_GUID kLoadedImage = {
    0x5b1b31a1, 0x9562, 0x11d2, {0x8e,0x3f,0x00,0xa0,0xc9,0x69,0x72,0x3b}
};
static const EFI_GUID kFileSystem = {
    0x964e5b22, 0x6459, 0x11d2, {0x8e,0x39,0x00,0xa0,0xc9,0x69,0x72,0x3b}
};
static const EFI_GUID kFileInfo = {
    0x09576e92, 0x6d3f, 0x11d2, {0x8e,0x39,0x00,0xa0,0xc9,0x69,0x72,0x3b}
};
static const EFI_CHAR16 kInitPath[] = {
    '\\','E','F','I','\\','S','W','Y','P','I','K','\\','I','N','I','T','.','S','W','D',0
};

EFI_STATUS swyp_uefi_load_init(EFI_HANDLE image_handle, EFI_SYSTEM_TABLE *system_table, SwypBootInfo *boot_info) {
    EFI_BOOT_SERVICES *bs;
    EFI_LOADED_IMAGE_PROTOCOL *loaded = NULL;
    EFI_SIMPLE_FILE_SYSTEM_PROTOCOL *fs = NULL;
    EFI_FILE_PROTOCOL *root = NULL, *file = NULL;
    EFI_PHYSICAL_ADDRESS memory = 0u;
    EFI_UINTN pages = 0u, consumed = 0u;
    EFI_STATUS status;
    _Alignas(8) uint8_t info_bytes[1024];
    EFI_FILE_INFO *info = (EFI_FILE_INFO *)(void *)info_bytes;
    EFI_UINTN info_size = sizeof(info_bytes);
    uint64_t expected = 0u;
    SwypX86DriverImageInfo parsed;
    int cleanup_failed = 0;
    if (boot_info == NULL || system_table == NULL || system_table->BootServices == NULL) {
        return EFI_INVALID_PARAMETER;
    }
    bs = system_table->BootServices;
    if (bs->HandleProtocol == NULL || bs->AllocatePages == NULL || bs->FreePages == NULL) {
        return EFI_INVALID_PARAMETER;
    }
    status = bs->HandleProtocol(image_handle, &kLoadedImage, (void **)&loaded);
    if (status != EFI_SUCCESS || loaded == NULL) {
        boot_info->init_status = SWYP_ERR_UNSUPPORTED;
        goto refused;
    }
    status = bs->HandleProtocol(loaded->DeviceHandle, &kFileSystem, (void **)&fs);
    if (status != EFI_SUCCESS || fs == NULL || fs->OpenVolume == NULL) {
        boot_info->init_status = SWYP_ERR_UNSUPPORTED;
        goto refused;
    }
    status = fs->OpenVolume(fs, &root);
    if (status != EFI_SUCCESS || root == NULL || root->Open == NULL || root->Close == NULL) {
        boot_info->init_status = SWYP_ERR_CORRUPT;
        goto refused;
    }
    status = root->Open(root, &file, kInitPath, EFI_FILE_MODE_READ, 0u);
    if (status == EFI_NOT_FOUND) {
        boot_info->init_status = SWYP_ERR_NOT_FOUND;
        goto cleanup;
    }
    if (status != EFI_SUCCESS || file == NULL || file->Read == NULL || file->Close == NULL || file->GetInfo == NULL) {
        boot_info->init_status = SWYP_ERR_CORRUPT;
        goto refused;
    }
    status = file->GetInfo(file, &kFileInfo, &info_size, info);
    if (status != EFI_SUCCESS || info_size < offsetof(EFI_FILE_INFO, FileName) ||
        info_size > sizeof(info_bytes) || info->Size < offsetof(EFI_FILE_INFO, FileName) || info->Size > info_size ||
        (info->Attribute & EFI_FILE_DIRECTORY) != 0u || info->FileSize == 0u) {
        boot_info->init_status = SWYP_ERR_CORRUPT;
        goto refused;
    }
    expected = info->FileSize;
    if (expected > SWYP_INIT_IMAGE_MAX_BYTES) {
        boot_info->init_status = SWYP_ERR_NO_SPACE;
        goto refused;
    }
    pages = (expected + 4095u) / 4096u;
    status = bs->AllocatePages(AllocateAnyPages, EfiLoaderData, pages, &memory);
    if (status != EFI_SUCCESS || memory == 0u) {
        boot_info->init_status = SWYP_ERR_NO_SPACE;
        goto refused;
    }
    while (consumed < expected) {
        EFI_UINTN chunk = expected - consumed;
        status = file->Read(file, &chunk, (uint8_t *)(uintptr_t)memory + consumed);
        if (status != EFI_SUCCESS || chunk == 0u || chunk > expected - consumed) {
            boot_info->init_status = SWYP_ERR_CORRUPT;
            goto refused;
        }
        consumed += chunk;
    }
    {
        uint8_t extra;
        EFI_UINTN one = 1u;
        status = file->Read(file, &one, &extra);
        if (status != EFI_SUCCESS || one != 0u) {
            boot_info->init_status = SWYP_ERR_CORRUPT;
            goto refused;
        }
    }
    boot_info->init_status = swyp_x86_driver_image_parse((const uint8_t *)(uintptr_t)memory, expected, &parsed);
    if (boot_info->init_status != SWYP_OK) {
        goto refused;
    }
    boot_info->init_image_address = memory;
    boot_info->init_image_bytes = expected;
    boot_info->init_image_pages = pages;
    boot_info->boot_flags |= SWYP_BOOT_FLAG_INIT_IMAGE_READY;
    goto cleanup;

refused:
    boot_info->boot_flags |= SWYP_BOOT_FLAG_INIT_REFUSED;
cleanup:
    if (file != NULL && (file->Close == NULL || file->Close(file) != EFI_SUCCESS)) {
        cleanup_failed = 1;
    }
    if (root != NULL && (root->Close == NULL || root->Close(root) != EFI_SUCCESS)) {
        cleanup_failed = 1;
    }
    if (memory != 0u && ((boot_info->boot_flags & SWYP_BOOT_FLAG_INIT_IMAGE_READY) == 0u || cleanup_failed)) {
        if (bs->FreePages(memory, pages) != EFI_SUCCESS) {
            cleanup_failed = 1;
        }
    }
    if (cleanup_failed) {
        boot_info->boot_flags &= ~SWYP_BOOT_FLAG_INIT_IMAGE_READY;
        boot_info->boot_flags |= SWYP_BOOT_FLAG_INIT_REFUSED;
        boot_info->init_status = SWYP_ERR_CORRUPT;
        boot_info->init_image_address = boot_info->init_image_bytes = boot_info->init_image_pages = 0u;
        return EFI_DEVICE_ERROR;
    }
    return EFI_SUCCESS;
}
