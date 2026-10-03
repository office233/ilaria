#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "swypik/boot/uefi_init.h"
#include "swypik/arch/x86_64/driver_image.h"
#include "swypik/kernel/driver_domain.h"

static int errors;
#define EXPECT(expr) do { if (!(expr)) { fprintf(stderr, "FAIL init_host_test:%d: %s\n", __LINE__, #expr); errors++; } } while (0)

static EFI_FILE_PROTOCOL root, file;
static EFI_SIMPLE_FILE_SYSTEM_PROTOCOL fs;
static EFI_LOADED_IMAGE_PROTOCOL loaded;
static uint8_t image[512];
static size_t image_size, position, chunk_limit;
static uint64_t reported_size;
static int absent, close_fails, directory, closes, allocations, frees;

static EFI_STATUS SWYP_EFIAPI fake_close(EFI_FILE_PROTOCOL *handle) {
    (void)handle;
    closes++;
    return close_fails ? EFI_DEVICE_ERROR : EFI_SUCCESS;
}

static EFI_STATUS SWYP_EFIAPI fake_open(EFI_FILE_PROTOCOL *handle, EFI_FILE_PROTOCOL **out,
                                        const EFI_CHAR16 *path, EFI_UINT64 mode, EFI_UINT64 attributes) {
    (void)handle;
    (void)attributes;
    EXPECT(path[0] == '\\' && mode == EFI_FILE_MODE_READ);
    if (absent) {
        return EFI_NOT_FOUND;
    }
    *out = &file;
    return EFI_SUCCESS;
}

static EFI_STATUS SWYP_EFIAPI fake_volume(EFI_SIMPLE_FILE_SYSTEM_PROTOCOL *volume, EFI_FILE_PROTOCOL **out) {
    (void)volume;
    *out = &root;
    return EFI_SUCCESS;
}

static EFI_STATUS SWYP_EFIAPI fake_protocol(EFI_HANDLE handle, const EFI_GUID *guid, void **out) {
    (void)handle;
    if (guid->Data1 == 0x5b1b31a1) {
        *out = &loaded;
    } else if (guid->Data1 == 0x964e5b22) {
        *out = &fs;
    } else {
        return EFI_NOT_FOUND;
    }
    return EFI_SUCCESS;
}

static EFI_STATUS SWYP_EFIAPI fake_info(EFI_FILE_PROTOCOL *handle, const EFI_GUID *guid,
                                        EFI_UINTN *size, void *buffer) {
    EFI_FILE_INFO *info = buffer;
    (void)handle;
    EXPECT(guid->Data1 == 0x09576e92 && *size >= sizeof(*info));
    memset(info, 0, sizeof(*info));
    info->Size = sizeof(*info);
    info->FileSize = reported_size;
    info->Attribute = directory ? EFI_FILE_DIRECTORY : 0u;
    *size = sizeof(*info);
    return EFI_SUCCESS;
}

static EFI_STATUS SWYP_EFIAPI fake_read(EFI_FILE_PROTOCOL *handle, EFI_UINTN *size, void *buffer) {
    size_t n = image_size - position;
    (void)handle;
    if (n > *size) { n = *size; }
    if (n > chunk_limit) { n = chunk_limit; }
    memcpy(buffer, image + position, n);
    position += n;
    *size = n;
    return EFI_SUCCESS;
}

static EFI_STATUS SWYP_EFIAPI fake_allocate(EFI_ALLOCATE_TYPE type, EFI_MEMORY_TYPE memory_type,
                                            EFI_UINTN pages, EFI_PHYSICAL_ADDRESS *address) {
    void *buffer;
    EXPECT(type == AllocateAnyPages && memory_type == EfiLoaderData);
    buffer = malloc((size_t)pages * 4096u);
    if (buffer == NULL) { return EFI_DEVICE_ERROR; }
    allocations++;
    *address = (uint64_t)(uintptr_t)buffer;
    return EFI_SUCCESS;
}

static EFI_STATUS SWYP_EFIAPI fake_free(EFI_PHYSICAL_ADDRESS address, EFI_UINTN pages) {
    (void)pages;
    frees++;
    free((void *)(uintptr_t)address);
    return EFI_SUCCESS;
}

static void put64(size_t offset, uint64_t value) { memcpy(image + offset, &value, 8u); }
static void reset(void) {
    uint16_t one = 1u, header = 64u;
    memset(&root, 0, sizeof(root));
    memset(&file, 0, sizeof(file));
    memset(&loaded, 0, sizeof(loaded));
    memset(image, 0, sizeof(image));
    memcpy(image, "SWYDRV1", 7u);
    memcpy(image + 8, &one, 2u);
    memcpy(image + 10, &header, 2u);
    memcpy(image + 12, &one, 2u);
    put64(32, 4096u);
    put64(64 + 8, 256u);
    put64(64 + 16, 1u);
    put64(64 + 24, 4096u);
    put64(64 + 32, SWYP_X86_DRIVER_SEGMENT_READ | SWYP_X86_DRIVER_SEGMENT_EXECUTE);
    image[256] = 0xc3;
    root.Open = fake_open;
    root.Close = fake_close;
    file.Close = fake_close;
    file.GetInfo = fake_info;
    file.Read = fake_read;
    fs.OpenVolume = fake_volume;
    image_size = 257u;
    reported_size = image_size;
    position = 0u;
    chunk_limit = 7u;
    absent = close_fails = directory = closes = allocations = frees = 0;
}

static void test_loader(void) {
    EFI_BOOT_SERVICES bs = {.HandleProtocol = fake_protocol, .AllocatePages = fake_allocate, .FreePages = fake_free};
    EFI_SYSTEM_TABLE table = {.BootServices = &bs};
    SwypBootInfo info;
    int mode;
    for (mode = 0; mode < 8; ++mode) {
        reset();
        swyp_boot_info_init(&info, SWYP_ARCH_X86_64, SWYP_FIRMWARE_UEFI, 0u);
        if (mode == 1) { absent = 1; }
        if (mode == 2) { image[0] = 'X'; }
        if (mode == 3) { reported_size = SWYP_INIT_IMAGE_MAX_BYTES + 1u; }
        if (mode == 4) { reported_size += 1u; } /* truncated file */
        if (mode == 5) { image_size += 1u; } /* file grew after GetInfo */
        if (mode == 6) { close_fails = 1; }
        if (mode == 7) { directory = 1; }
        EXPECT(swyp_uefi_load_init((EFI_HANDLE)(uintptr_t)1u, &table, &info) ==
               (mode == 6 ? EFI_DEVICE_ERROR : EFI_SUCCESS));
        EXPECT(closes == (mode == 1 ? 1 : 2));
        if (mode == 0) {
            EXPECT(info.init_status == SWYP_OK && info.init_image_bytes == 257u);
            EXPECT((info.boot_flags & SWYP_BOOT_FLAG_INIT_IMAGE_READY) != 0u);
            EXPECT(allocations == 1 && frees == 0);
            EXPECT(memcmp((const void *)(uintptr_t)info.init_image_address, image, 257u) == 0);
            fake_free(info.init_image_address, info.init_image_pages);
        } else if (mode == 1) {
            EXPECT(info.init_status == SWYP_ERR_NOT_FOUND && info.boot_flags == 0u);
            EXPECT(allocations == 0);
        } else {
            EXPECT(info.init_status != SWYP_OK && info.init_image_address == 0u && info.init_image_bytes == 0u);
            EXPECT(info.boot_flags == SWYP_BOOT_FLAG_INIT_REFUSED);
            EXPECT(allocations == frees);
        }
    }
}

static void test_compute_domain(void) {
    SwypCapabilityTable capabilities;
    SwypDriverDomainManager manager;
    SwypDriverDomainPolicy policy;
    SwypDeviceGraph graph;
    SwypDeviceNode node = {.id = 1u, .device_class = SWYP_DEVICE_CLASS_COMPUTE, .bus = SWYP_DEVICE_BUS_PLATFORM};
    const SwypDriverDomain *domain = NULL;
    swyp_capability_table_init(&capabilities);
    swyp_driver_domain_manager_init(&manager, &capabilities);
    swyp_driver_domain_policy_init(&policy);
    swyp_device_graph_init(&graph);
    EXPECT(swyp_device_graph_add_node(&graph, &node) == SWYP_OK);
    /* The existing resource-bearing path still refuses an empty grant list. */
    EXPECT(swyp_driver_domain_open(&manager, &graph, 1u, 7u, 1u, &policy, &domain) == SWYP_ERR_INVALID);
    EXPECT(swyp_driver_domain_open_compute(&manager, &graph, 1u, 7u, 1u, &domain) == SWYP_OK);
    EXPECT(domain != NULL && domain->grant_count == 0u);
    EXPECT(swyp_driver_domain_quiesce(&manager, 7u, 1u) == SWYP_OK);
    EXPECT(swyp_driver_domain_revoke(&manager, 7u, 1u) == SWYP_OK);
    graph.nodes[0].bus = SWYP_DEVICE_BUS_PCI;
    EXPECT(swyp_driver_domain_open_compute(&manager, &graph, 1u, 8u, 1u, &domain) == SWYP_ERR_DENIED);
    graph.nodes[0].bus = SWYP_DEVICE_BUS_PLATFORM;
    graph.nodes[0].device_class = SWYP_DEVICE_CLASS_NETWORK;
    EXPECT(swyp_driver_domain_open_compute(&manager, &graph, 1u, 8u, 1u, &domain) == SWYP_ERR_DENIED);
}

int swyp_test_init_host(void) {
    test_loader();
    test_compute_domain();
    return errors;
}
