#include <stdio.h>
#include <string.h>

#include "swypik/arch/x86_64/address_space.h"
#include "swypik/arch/x86_64/apic.h"
#include "swypik/arch/x86_64/apic_mmio.h"
#include "swypik/arch/x86_64/continuation.h"
#include "swypik/arch/x86_64/driver_image.h"
#include "swypik/arch/x86_64/driver_runtime.h"
#include "swypik/arch/x86_64/kernel_root.h"
#include "swypik/arch/x86_64/native_mmu.h"
#include "swypik/arch/x86_64/platform_boot.h"
#include "swypik/arch/x86_64/privilege.h"
#include "swypik/arch/x86_64/scheduler.h"
#include "swypik/arch/x86_64/trap.h"
#include "swypik/arch/x86_64/user_mode.h"
#include "swypik/arch/x86_64/vtd.h"
#include "swypik/arch/x86_64/vtd_router.h"
#include "swypik/boot/uefi_handoff.h"
#include "swypik/boot/uefi_acpi.h"
#include "swypik/boot/uefi_bootstrap.h"
#include "swypik/boot/uefi_memory.h"
#include "swypik/boot/pe_image.h"
#include "swypik/boot/uefi_takeover.h"
#include "swypik/kernel/capability.h"
#include "swypik/kernel/contracts.h"
#include "swypik/kernel/device_broker.h"
#include "swypik/kernel/device_graph.h"
#include "swypik/kernel/device_platform.h"
#include "swypik/kernel/driver_domain.h"
#include "swypik/kernel/ipc.h"
#include "swypik/kernel/kernel_entry.h"
#include "swypik/kernel/kernel_runtime.h"
#include "swypik/kernel/kernel_takeover.h"
#include "swypik/kernel/scheduler.h"

static int failures = 0;

#define CHECK(expr)                                                                                 \
    do {                                                                                            \
        if (!(expr)) {                                                                              \
            fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #expr);                       \
            failures += 1;                                                                         \
        }                                                                                           \
    } while (0)

static void test_put_u16(uint8_t *dst, uint16_t value) {
    dst[0] = (uint8_t)(value & 0xffu);
    dst[1] = (uint8_t)((value >> 8) & 0xffu);
}

static void test_put_u32(uint8_t *dst, uint32_t value) {
    dst[0] = (uint8_t)(value & 0xffu);
    dst[1] = (uint8_t)((value >> 8) & 0xffu);
    dst[2] = (uint8_t)((value >> 16) & 0xffu);
    dst[3] = (uint8_t)((value >> 24) & 0xffu);
}

static void test_put_u64(uint8_t *dst, uint64_t value) {
    test_put_u32(dst, (uint32_t)(value & UINT64_C(0xffffffff)));
    test_put_u32(dst + 4u, (uint32_t)(value >> 32));
}

static void test_boot_contracts(void) {
    SwypBootInfo boot_info;
    swyp_boot_info_init(&boot_info, SWYP_ARCH_X86_64, SWYP_FIRMWARE_UEFI, UINT64_C(0x12340000));
    CHECK(boot_info.magic == SWYP_BOOT_INFO_MAGIC);
    CHECK(boot_info.abi_version == SWYP_KERNEL_ABI_VERSION);
    CHECK(boot_info.struct_size == sizeof(boot_info));
    CHECK(boot_info.arch.arch == SWYP_ARCH_X86_64);
    CHECK(boot_info.arch.endianness == SWYP_ENDIAN_LITTLE);
    CHECK(boot_info.arch.native_word_bits == 64u);
    CHECK(boot_info.arch.base_page_shift == 12u);
    CHECK(boot_info.physical_memory.abi_version == SWYP_KERNEL_ABI_VERSION);
}

static void test_uefi_page_allocator(void) {
    enum { STRIDE = (int)sizeof(EFI_MEMORY_DESCRIPTOR) + 8, COUNT = 4 };
    uint8_t raw[STRIDE * COUNT];
    EFI_MEMORY_DESCRIPTOR descriptors[COUNT];
    SwypPhysicalMemoryMap memory_map = {0};
    SwypUefiPageAllocator allocator_state;
    SwypPageAllocator *allocator;
    uint64_t initial_pages;
    uint64_t a = 0u;
    uint64_t b = 0u;
    uint32_t i;

    memset(raw, 0, sizeof(raw));
    memset(descriptors, 0, sizeof(descriptors));
    descriptors[0].Type = (EFI_UINT32)EfiLoaderData;
    descriptors[0].PhysicalStart = UINT64_C(0x100000);
    descriptors[0].NumberOfPages = 8u;
    descriptors[1].Type = (EFI_UINT32)EfiConventionalMemory;
    descriptors[1].PhysicalStart = 0u;
    descriptors[1].NumberOfPages = 512u;
    descriptors[2].Type = (EFI_UINT32)EfiConventionalMemory;
    descriptors[2].PhysicalStart = UINT64_C(0x400000);
    descriptors[2].NumberOfPages = 16u;
    descriptors[3].Type = (EFI_UINT32)EfiRuntimeServicesData;
    descriptors[3].PhysicalStart = UINT64_C(0x500000);
    descriptors[3].NumberOfPages = 16u;
    for (i = 0; i < COUNT; ++i) {
        memcpy(raw + i * STRIDE, &descriptors[i], sizeof(descriptors[i]));
    }
    memory_map.source = SWYP_MEMORY_MAP_UEFI;
    memory_map.entries_address = (uint64_t)(uintptr_t)raw;
    memory_map.buffer_bytes = sizeof(raw);
    memory_map.entry_count = COUNT;
    memory_map.entry_stride = STRIDE;
    CHECK(swyp_uefi_page_allocator_init(&allocator_state, &memory_map) == SWYP_OK);
    allocator = swyp_uefi_page_allocator_contract(&allocator_state);
    CHECK(allocator != NULL && allocator->ops != NULL);
    initial_pages = swyp_uefi_page_allocator_free_pages(&allocator_state);
    CHECK(initial_pages == UINT64_C(272));
    CHECK(allocator->ops->allocate(allocator->context, 2u, 4u, &a) == SWYP_OK);
    CHECK(a == UINT64_C(0x100000) && (a & UINT64_C(0x3fff)) == 0u);
    CHECK(allocator->ops->allocate(allocator->context, 3u, 1u, &b) == SWYP_OK);
    CHECK(b == UINT64_C(0x102000));
    CHECK(swyp_uefi_page_allocator_free_pages(&allocator_state) == initial_pages - 5u);
    CHECK(allocator->ops->release(allocator->context, a, 2u) == SWYP_OK);
    CHECK(allocator->ops->release(allocator->context, b, 3u) == SWYP_OK);
    CHECK(swyp_uefi_page_allocator_free_pages(&allocator_state) == initial_pages);
    CHECK(allocator->ops->release(allocator->context, b, 3u) == SWYP_ERR_INVALID);
    CHECK(allocator->ops->release(allocator->context, UINT64_C(0x500000), 1u) == SWYP_ERR_INVALID);
    CHECK(allocator->ops->allocate(allocator->context, 1u, 3u, &a) == SWYP_ERR_INVALID);
    CHECK(allocator->ops->allocate(allocator->context, 32u, 1024u, &a) == SWYP_ERR_NO_SPACE);
}

typedef struct FakeUefiBootState {
    uint32_t get_map_calls;
    uint32_t exit_calls;
    uint32_t fail_first_exit;
    uint32_t force_exit_device_error;
    uint32_t include_takeover_ranges;
    EFI_UINTN last_exit_key;
} FakeUefiBootState;

static FakeUefiBootState g_fake_uefi_boot;

#define TEST_UEFI_BOOTSTRAP_PAGES 32u
static _Alignas(4096) uint8_t g_fake_uefi_bootstrap_pages[TEST_UEFI_BOOTSTRAP_PAGES][4096];
static _Alignas(4096) uint8_t g_fake_acpi_page[4096];

typedef struct FakeUefiPageState {
    uint32_t allocate_calls;
    uint32_t free_calls;
    uint32_t allocated;
    EFI_UINTN pages;
} FakeUefiPageState;

static FakeUefiPageState g_fake_uefi_pages;
static _Alignas(4096) uint8_t g_fake_loaded_pe[0x5000];
static EFI_LOADED_IMAGE_PROTOCOL g_fake_loaded_image;

static void test_acpi_fix_checksum(uint8_t *bytes, uint32_t length, uint32_t checksum_offset) {
    uint8_t sum = 0u;
    uint32_t i;
    bytes[checksum_offset] = 0u;
    for (i = 0u; i < length; ++i) {
        sum = (uint8_t)(sum + bytes[i]);
    }
    bytes[checksum_offset] = (uint8_t)(0u - sum);
}

static void build_fake_rsdp(void) {
    uint8_t *rsdp = g_fake_acpi_page;
    memset(g_fake_acpi_page, 0, sizeof(g_fake_acpi_page));
    memcpy(rsdp, "RSD PTR ", 8u);
    memcpy(rsdp + 9u, "SWYPIK", 6u);
    rsdp[15] = 2u;
    test_put_u32(rsdp + 16u, 0u);
    test_put_u32(rsdp + 20u, 36u);
    test_put_u32(rsdp + 24u, 0u);
    test_put_u32(rsdp + 28u, 0u);
    test_acpi_fix_checksum(rsdp, 20u, 8u);
    test_acpi_fix_checksum(rsdp, 36u, 32u);
}

static EFI_CONFIGURATION_TABLE fake_acpi_configuration(void) {
    EFI_CONFIGURATION_TABLE table = {0};
    table.VendorGuid.Data1 = UINT32_C(0x8868e871);
    table.VendorGuid.Data2 = UINT16_C(0xe4f1);
    table.VendorGuid.Data3 = UINT16_C(0x11d3);
    table.VendorGuid.Data4[0] = 0xbc;
    table.VendorGuid.Data4[1] = 0x22;
    table.VendorGuid.Data4[2] = 0x00;
    table.VendorGuid.Data4[3] = 0x80;
    table.VendorGuid.Data4[4] = 0xc7;
    table.VendorGuid.Data4[5] = 0x3c;
    table.VendorGuid.Data4[6] = 0x88;
    table.VendorGuid.Data4[7] = 0x81;
    table.VendorTable = g_fake_acpi_page;
    return table;
}

static EFI_STATUS SWYP_EFIAPI fake_uefi_allocate_pages(EFI_ALLOCATE_TYPE type, EFI_MEMORY_TYPE memory_type,
                                                        EFI_UINTN pages, EFI_PHYSICAL_ADDRESS *memory) {
    g_fake_uefi_pages.allocate_calls += 1u;
    if (type != AllocateAnyPages || memory_type != EfiLoaderData || pages == 0u ||
        pages > TEST_UEFI_BOOTSTRAP_PAGES || memory == NULL || g_fake_uefi_pages.allocated != 0u) {
        return EFI_INVALID_PARAMETER;
    }
    g_fake_uefi_pages.allocated = 1u;
    g_fake_uefi_pages.pages = pages;
    *memory = (EFI_PHYSICAL_ADDRESS)(uintptr_t)&g_fake_uefi_bootstrap_pages[0][0];
    return EFI_SUCCESS;
}

static EFI_STATUS SWYP_EFIAPI fake_uefi_free_pages(EFI_PHYSICAL_ADDRESS memory, EFI_UINTN pages) {
    g_fake_uefi_pages.free_calls += 1u;
    if (g_fake_uefi_pages.allocated == 0u || memory != (EFI_PHYSICAL_ADDRESS)(uintptr_t)&g_fake_uefi_bootstrap_pages[0][0] ||
        pages != g_fake_uefi_pages.pages) {
        return EFI_INVALID_PARAMETER;
    }
    g_fake_uefi_pages.allocated = 0u;
    g_fake_uefi_pages.pages = 0u;
    return EFI_SUCCESS;
}

static EFI_STATUS SWYP_EFIAPI fake_uefi_handle_protocol(EFI_HANDLE handle, const EFI_GUID *protocol,
                                                         void **interface) {
    if (handle == NULL || protocol == NULL || interface == NULL || protocol->Data1 != UINT32_C(0x5b1b31a1)) {
        return EFI_INVALID_PARAMETER;
    }
    *interface = &g_fake_loaded_image;
    return EFI_SUCCESS;
}

static void build_fake_loaded_pe(int writable_executable_data) {
    uint32_t pe_offset = 0x80u;
    uint32_t optional_offset = pe_offset + 24u;
    uint32_t section_offset = optional_offset + 0xf0u;
    memset(g_fake_loaded_pe, 0, sizeof(g_fake_loaded_pe));
    g_fake_loaded_pe[0] = 'M';
    g_fake_loaded_pe[1] = 'Z';
    test_put_u32(g_fake_loaded_pe + 0x3cu, pe_offset);
    g_fake_loaded_pe[pe_offset + 0u] = 'P';
    g_fake_loaded_pe[pe_offset + 1u] = 'E';
    test_put_u16(g_fake_loaded_pe + pe_offset + 6u, 2u);
    test_put_u16(g_fake_loaded_pe + pe_offset + 20u, 0xf0u);
    test_put_u16(g_fake_loaded_pe + optional_offset, 0x020bu);
    test_put_u32(g_fake_loaded_pe + optional_offset + 56u, 0x4000u);
    test_put_u32(g_fake_loaded_pe + optional_offset + 60u, 0x1000u);
    test_put_u32(g_fake_loaded_pe + section_offset + 8u, 0x800u);
    test_put_u32(g_fake_loaded_pe + section_offset + 12u, 0x1000u);
    test_put_u32(g_fake_loaded_pe + section_offset + 16u, 0x800u);
    test_put_u32(g_fake_loaded_pe + section_offset + 36u, UINT32_C(0x60000000));
    section_offset += 40u;
    test_put_u32(g_fake_loaded_pe + section_offset + 8u, 0x800u);
    test_put_u32(g_fake_loaded_pe + section_offset + 12u, 0x2000u);
    test_put_u32(g_fake_loaded_pe + section_offset + 16u, 0x800u);
    test_put_u32(g_fake_loaded_pe + section_offset + 36u,
                 writable_executable_data ? UINT32_C(0xe0000000) : UINT32_C(0xc0000000));
    memset(&g_fake_loaded_image, 0, sizeof(g_fake_loaded_image));
    g_fake_loaded_image.ImageBase = g_fake_loaded_pe;
    g_fake_loaded_image.ImageSize = sizeof(g_fake_loaded_pe);
    g_fake_loaded_image.ImageCodeType = EfiLoaderCode;
    g_fake_loaded_image.ImageDataType = EfiLoaderData;
}

static EFI_STATUS SWYP_EFIAPI fake_uefi_get_memory_map(EFI_UINTN *memory_map_size, EFI_MEMORY_DESCRIPTOR *memory_map,
                                                        EFI_UINTN *map_key, EFI_UINTN *descriptor_size,
                                                        EFI_UINT32 *descriptor_version) {
    EFI_MEMORY_DESCRIPTOR descriptors[4] = {0};
    EFI_UINTN count = g_fake_uefi_boot.include_takeover_ranges != 0u ? 4u : 1u;
    EFI_UINTN required = count * (EFI_UINTN)sizeof(EFI_MEMORY_DESCRIPTOR);
    g_fake_uefi_boot.get_map_calls += 1u;
    if (memory_map_size == NULL || map_key == NULL || descriptor_size == NULL || descriptor_version == NULL) {
        return EFI_INVALID_PARAMETER;
    }
    if (memory_map == NULL || *memory_map_size < required) {
        *memory_map_size = required;
        return EFI_BUFFER_TOO_SMALL;
    }
    descriptors[0].Type = (EFI_UINT32)EfiConventionalMemory;
    descriptors[0].PhysicalStart = UINT64_C(0x200000);
    descriptors[0].NumberOfPages = 32u;
    if (count > 1u) {
        descriptors[1].Type = (EFI_UINT32)EfiLoaderData;
        descriptors[1].PhysicalStart = (EFI_PHYSICAL_ADDRESS)(uintptr_t)&g_fake_loaded_pe[0];
        descriptors[1].NumberOfPages = sizeof(g_fake_loaded_pe) / 4096u;
        descriptors[2].Type = (EFI_UINT32)EfiLoaderData;
        descriptors[2].PhysicalStart = (EFI_PHYSICAL_ADDRESS)(uintptr_t)&g_fake_uefi_bootstrap_pages[0][0];
        descriptors[2].NumberOfPages = g_fake_uefi_pages.pages;
        descriptors[3].Type = (EFI_UINT32)EfiACPIReclaimMemory;
        descriptors[3].PhysicalStart = (EFI_PHYSICAL_ADDRESS)(uintptr_t)&g_fake_acpi_page[0];
        descriptors[3].NumberOfPages = 1u;
    }
    memcpy(memory_map, descriptors, (size_t)required);
    *memory_map_size = required;
    *map_key = (EFI_UINTN)(UINT64_C(0x1000) + g_fake_uefi_boot.get_map_calls);
    *descriptor_size = sizeof(EFI_MEMORY_DESCRIPTOR);
    *descriptor_version = 1u;
    return EFI_SUCCESS;
}

static EFI_STATUS SWYP_EFIAPI fake_uefi_exit_boot_services(EFI_HANDLE image_handle, EFI_UINTN map_key) {
    if (image_handle == NULL) {
        return EFI_INVALID_PARAMETER;
    }
    g_fake_uefi_boot.exit_calls += 1u;
    g_fake_uefi_boot.last_exit_key = map_key;
    if (g_fake_uefi_boot.force_exit_device_error != 0u) {
        return EFI_DEVICE_ERROR;
    }
    if (g_fake_uefi_boot.fail_first_exit != 0u && g_fake_uefi_boot.exit_calls == 1u) {
        return EFI_INVALID_PARAMETER;
    }
    return EFI_SUCCESS;
}

static void test_uefi_exit_boot_services_retry(void) {
    uint8_t memory_map[256];
    EFI_BOOT_SERVICES boot_services = {0};
    EFI_SYSTEM_TABLE system_table = {0};
    SwypBootInfo boot_info;
    EFI_HANDLE image_handle = (EFI_HANDLE)(uintptr_t)UINT64_C(0x1234);

    memset(&g_fake_uefi_boot, 0, sizeof(g_fake_uefi_boot));
    g_fake_uefi_boot.fail_first_exit = 1u;
    boot_services.GetMemoryMap = fake_uefi_get_memory_map;
    boot_services.ExitBootServices = fake_uefi_exit_boot_services;
    system_table.BootServices = &boot_services;
    swyp_boot_info_init(&boot_info, SWYP_ARCH_X86_64, SWYP_FIRMWARE_UEFI, (uint64_t)(uintptr_t)&system_table);
    CHECK(swyp_uefi_exit_boot_services(image_handle, &system_table, memory_map, sizeof(memory_map), &boot_info, 4u) ==
          EFI_SUCCESS);
    CHECK(g_fake_uefi_boot.get_map_calls == 2u && g_fake_uefi_boot.exit_calls == 2u);
    CHECK(g_fake_uefi_boot.last_exit_key == UINT64_C(0x1002));
    CHECK((boot_info.boot_flags & SWYP_BOOT_FLAG_EXITED_BOOT_SERVICES) != 0u);
    CHECK(boot_info.physical_memory.entry_count == 1u &&
          boot_info.physical_memory.entry_stride == sizeof(EFI_MEMORY_DESCRIPTOR));

    memset(&g_fake_uefi_boot, 0, sizeof(g_fake_uefi_boot));
    g_fake_uefi_boot.force_exit_device_error = 1u;
    swyp_boot_info_init(&boot_info, SWYP_ARCH_X86_64, SWYP_FIRMWARE_UEFI, (uint64_t)(uintptr_t)&system_table);
    CHECK(swyp_uefi_exit_boot_services(image_handle, &system_table, memory_map, sizeof(memory_map), &boot_info, 4u) ==
          EFI_DEVICE_ERROR);
    CHECK(g_fake_uefi_boot.get_map_calls == 1u && g_fake_uefi_boot.exit_calls == 1u);
    CHECK((boot_info.boot_flags & SWYP_BOOT_FLAG_EXITED_BOOT_SERVICES) == 0u);
}

static void test_uefi_acpi_root_capture(void) {
    EFI_SYSTEM_TABLE system_table = {0};
    EFI_CONFIGURATION_TABLE configuration;
    SwypBootInfo boot_info;

    build_fake_rsdp();
    configuration = fake_acpi_configuration();
    system_table.NumberOfTableEntries = 1u;
    system_table.ConfigurationTable = &configuration;
    swyp_boot_info_init(&boot_info, SWYP_ARCH_X86_64, SWYP_FIRMWARE_UEFI, (uint64_t)(uintptr_t)&system_table);
    CHECK(swyp_uefi_capture_acpi_root(&system_table, &boot_info) == SWYP_OK);
    CHECK(boot_info.acpi_rsdp_address == (uint64_t)(uintptr_t)g_fake_acpi_page);
    CHECK(boot_info.acpi_rsdp_length == 36u && boot_info.acpi_revision == 2u);

    g_fake_acpi_page[33] ^= 0x01u;
    CHECK(swyp_uefi_capture_acpi_root(&system_table, &boot_info) == SWYP_ERR_CORRUPT);
    build_fake_rsdp();
    system_table.NumberOfTableEntries = 0u;
    CHECK(swyp_uefi_capture_acpi_root(&system_table, &boot_info) == SWYP_ERR_NOT_FOUND);
}

static void test_acpi_dmar_device_scopes(void) {
    uint8_t dmar[104] = {0};
    SwypAcpiPlatform platform = {0};
    SwypAcpiDmarScope *scope;
    uint32_t unit_index = UINT32_MAX;
    uint64_t reserved_base = 0u;
    uint64_t reserved_limit = 0u;

    memcpy(dmar, "DMAR", 4u);
    test_put_u32(dmar + 4u, sizeof(dmar));
    dmar[36] = 47u;
    dmar[37] = 0u;

    /* DRHD, segment 0, include-all, one endpoint scope 02:03.1. */
    test_put_u16(dmar + 48u, 0u);
    test_put_u16(dmar + 50u, 24u);
    dmar[52] = 1u;
    test_put_u16(dmar + 54u, 0u);
    test_put_u64(dmar + 56u, UINT64_C(0xfed90000));
    dmar[64] = 1u;
    dmar[65] = 8u;
    dmar[68] = 0u;
    dmar[69] = 2u;
    dmar[70] = 3u;
    dmar[71] = 1u;

    /* RMRR for segment 0, one endpoint scope 00:04.0. */
    test_put_u16(dmar + 72u, 1u);
    test_put_u16(dmar + 74u, 32u);
    test_put_u16(dmar + 78u, 0u);
    test_put_u64(dmar + 80u, UINT64_C(0x9f000));
    test_put_u64(dmar + 88u, UINT64_C(0x9ffff));
    dmar[96] = 1u;
    dmar[97] = 8u;
    dmar[100] = 0u;
    dmar[101] = 0u;
    dmar[102] = 4u;
    dmar[103] = 0u;

    CHECK(swyp_acpi_parse_dmar_table(dmar, sizeof(dmar), &platform) == SWYP_OK);
    CHECK(platform.dmar_host_address_width == 48u);
    CHECK(platform.dmar_unit_count == 1u && platform.dmar_reserved_count == 1u && platform.dmar_scope_count == 2u);
    CHECK(platform.dmar_units[0].register_base == UINT64_C(0xfed90000));
    CHECK(platform.dmar_units[0].first_scope == 0u && platform.dmar_units[0].scope_count == 1u);
    CHECK(platform.dmar_reserved[0].first_scope == 1u && platform.dmar_reserved[0].scope_count == 1u);
    scope = &platform.dmar_scopes[0];
    CHECK(scope->type == 1u && scope->segment == 0u && scope->start_bus == 2u && scope->path_count == 1u);
    CHECK(scope->path[0].device == 3u && scope->path[0].function == 1u);
    scope = &platform.dmar_scopes[1];
    CHECK(scope->type == 1u && scope->start_bus == 0u && scope->path[0].device == 4u &&
          scope->path[0].function == 0u);
    CHECK(swyp_acpi_dmar_select_unit(&platform, 0u, 2u, 3u, 1u, &unit_index) == SWYP_OK && unit_index == 0u);
    CHECK(swyp_acpi_dmar_select_unit(&platform, 0u, 9u, 1u, 0u, &unit_index) == SWYP_OK && unit_index == 0u);
    CHECK(swyp_acpi_dmar_reserved_for_requester(&platform, 0u, 0u, 4u, 0u, &reserved_base, &reserved_limit) ==
          SWYP_OK);
    CHECK(reserved_base == UINT64_C(0x9f000) && reserved_limit == UINT64_C(0x9ffff));
    CHECK(swyp_acpi_dmar_reserved_for_requester(&platform, 0u, 2u, 3u, 1u, &reserved_base, &reserved_limit) ==
          SWYP_ERR_NOT_FOUND);

    /* Multi-hop paths are preserved rather than flattened into an invented BDF. */
    memset(&platform, 0, sizeof(platform));
    memset(dmar + 48u, 0, sizeof(dmar) - 48u);
    test_put_u32(dmar + 4u, 74u);
    test_put_u16(dmar + 48u, 0u);
    test_put_u16(dmar + 50u, 26u);
    test_put_u16(dmar + 54u, 7u);
    test_put_u64(dmar + 56u, UINT64_C(0xfeda0000));
    dmar[64] = 2u;
    dmar[65] = 10u;
    dmar[68] = 9u;
    dmar[69] = 5u;
    dmar[70] = 1u;
    dmar[71] = 0u;
    dmar[72] = 6u;
    dmar[73] = 2u;
    CHECK(swyp_acpi_parse_dmar_table(dmar, 74u, &platform) == SWYP_OK);
    CHECK(platform.dmar_scope_count == 1u && platform.dmar_scopes[0].segment == 7u &&
          platform.dmar_scopes[0].enumeration_id == 9u && platform.dmar_scopes[0].start_bus == 5u &&
          platform.dmar_scopes[0].path_count == 2u);
    CHECK(platform.dmar_scopes[0].path[1].device == 6u && platform.dmar_scopes[0].path[1].function == 2u);
    CHECK(swyp_acpi_dmar_select_unit(&platform, 7u, 8u, 1u, 0u, &unit_index) == SWYP_ERR_UNSUPPORTED);

    /* Malformed scope lengths and impossible PCI path elements fail closed. */
    dmar[65] = 7u;
    memset(&platform, 0, sizeof(platform));
    CHECK(swyp_acpi_parse_dmar_table(dmar, 74u, &platform) == SWYP_ERR_CORRUPT);
    dmar[65] = 10u;
    dmar[70] = 32u;
    memset(&platform, 0, sizeof(platform));
    CHECK(swyp_acpi_parse_dmar_table(dmar, 74u, &platform) == SWYP_ERR_CORRUPT);

    /* Two include-all units for one segment are ambiguous firmware policy. */
    memset(&platform, 0, sizeof(platform));
    platform.dmar_unit_count = 2u;
    platform.dmar_units[0].segment = 0u;
    platform.dmar_units[0].flags = 1u;
    platform.dmar_units[1].segment = 0u;
    platform.dmar_units[1].flags = 1u;
    CHECK(swyp_acpi_dmar_select_unit(&platform, 0u, 0u, 1u, 0u, &unit_index) == SWYP_ERR_CORRUPT);

    /* An exact endpoint scope overrides an include-all unit on the same segment. */
    memset(&platform, 0, sizeof(platform));
    platform.dmar_unit_count = 2u;
    platform.dmar_units[0].segment = 0u;
    platform.dmar_units[0].flags = 1u;
    platform.dmar_units[1].segment = 0u;
    platform.dmar_units[1].first_scope = 0u;
    platform.dmar_units[1].scope_count = 1u;
    platform.dmar_scope_count = 1u;
    platform.dmar_scopes[0].type = 1u;
    platform.dmar_scopes[0].segment = 0u;
    platform.dmar_scopes[0].start_bus = 4u;
    platform.dmar_scopes[0].path_count = 1u;
    platform.dmar_scopes[0].path[0].device = 7u;
    platform.dmar_scopes[0].path[0].function = 2u;
    CHECK(swyp_acpi_dmar_select_unit(&platform, 0u, 4u, 7u, 2u, &unit_index) == SWYP_OK && unit_index == 1u);
    CHECK(swyp_acpi_dmar_select_unit(&platform, 0u, 4u, 8u, 0u, &unit_index) == SWYP_OK && unit_index == 0u);
}

static void test_uefi_bootstrap_arena(void) {
    EFI_BOOT_SERVICES boot_services = {0};
    EFI_SYSTEM_TABLE system_table = {0};
    SwypUefiBootstrapArena arena;
    SwypPageAllocator *allocator;
    const SwypX86AddressSpaceHardwareOps *mmu_ops;
    uint64_t first = 0u;
    uint64_t second = 0u;
    uint64_t base = (uint64_t)(uintptr_t)&g_fake_uefi_bootstrap_pages[0][0];

    memset(&g_fake_uefi_pages, 0, sizeof(g_fake_uefi_pages));
    memset(g_fake_uefi_bootstrap_pages, 0xa5, sizeof(g_fake_uefi_bootstrap_pages));
    boot_services.AllocatePages = fake_uefi_allocate_pages;
    boot_services.FreePages = fake_uefi_free_pages;
    system_table.BootServices = &boot_services;

    CHECK(swyp_uefi_bootstrap_arena_init(&system_table, &arena, 8u, 2u) == SWYP_OK);
    CHECK(g_fake_uefi_pages.allocate_calls == 1u && g_fake_uefi_pages.allocated != 0u);
    CHECK(arena.physical_base == base && arena.guard_pages == SWYP_UEFI_BOOTSTRAP_GUARD_PAGES &&
          arena.ist_pages == SWYP_UEFI_BOOTSTRAP_IST_PAGES &&
          arena.ist_guard_pages == SWYP_UEFI_BOOTSTRAP_IST_GUARD_PAGES &&
          swyp_uefi_bootstrap_arena_bytes(&arena) == UINT64_C(14) * 4096u);
    CHECK(swyp_uefi_bootstrap_table_bytes(&arena) == UINT64_C(8) * 4096u);
    CHECK(swyp_uefi_bootstrap_guard_base(&arena) == base + UINT64_C(8) * 4096u);
    CHECK(swyp_uefi_bootstrap_ist_base(&arena) == base + UINT64_C(9) * 4096u);
    CHECK(swyp_uefi_bootstrap_ist_top(&arena) == base + UINT64_C(11) * 4096u);
    CHECK(swyp_uefi_bootstrap_ist_guard_base(&arena) == base + UINT64_C(11) * 4096u);
    CHECK(swyp_uefi_bootstrap_stack_base(&arena) == base + UINT64_C(12) * 4096u);
    CHECK(swyp_uefi_bootstrap_stack_top(&arena) == base + UINT64_C(14) * 4096u);
    CHECK(g_fake_uefi_bootstrap_pages[0][0] == 0u && g_fake_uefi_bootstrap_pages[13][4095] == 0u);

    allocator = swyp_uefi_bootstrap_page_allocator(&arena);
    CHECK(allocator != NULL && allocator->ops != NULL);
    CHECK(allocator->ops->allocate(allocator->context, 2u, 2u, &first) == SWYP_OK);
    CHECK(first == base);
    CHECK(allocator->ops->allocate(allocator->context, 1u, 4u, &second) == SWYP_OK);
    CHECK(second == base + UINT64_C(4) * 4096u);
    CHECK(allocator->ops->release(allocator->context, first, 2u) == SWYP_OK);
    CHECK(allocator->ops->release(allocator->context, first, 2u) == SWYP_ERR_INVALID);
    CHECK(allocator->ops->release(allocator->context, second, 1u) == SWYP_OK);

    mmu_ops = swyp_uefi_bootstrap_mmu_ops();
    CHECK(mmu_ops != NULL && mmu_ops->physical_to_virtual != NULL);
    CHECK(mmu_ops->physical_to_virtual(&arena, base) == (void *)(uintptr_t)base);
    CHECK(mmu_ops->physical_to_virtual(&arena, base + UINT64_C(14) * 4096u) == NULL);

    CHECK(swyp_uefi_bootstrap_arena_release(&system_table, &arena) == SWYP_OK);
    CHECK(g_fake_uefi_pages.free_calls == 1u && g_fake_uefi_pages.allocated == 0u);
    CHECK(swyp_uefi_bootstrap_page_allocator(&arena) == NULL);
}

static void test_pe_identity_ranges(void) {
    SwypKernelIdentityRange ranges[8];
    uint32_t range_count = 0u;
    uint64_t base = (uint64_t)(uintptr_t)g_fake_loaded_pe;

    build_fake_loaded_pe(0);
    CHECK(swyp_pe_collect_identity_ranges(g_fake_loaded_pe, sizeof(g_fake_loaded_pe), ranges, 8u, &range_count) ==
          SWYP_OK);
    CHECK(range_count == 3u);
    CHECK(ranges[0].base == base && ranges[0].length == 0x1000u &&
          ranges[0].flags == (SWYP_MMU_READ | SWYP_MMU_GLOBAL));
    CHECK(ranges[1].base == base + 0x1000u && ranges[1].length == 0x1000u &&
          ranges[1].flags == (SWYP_MMU_READ | SWYP_MMU_EXECUTE | SWYP_MMU_GLOBAL));
    CHECK(ranges[2].base == base + 0x2000u && ranges[2].length == 0x1000u &&
          ranges[2].flags == (SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_GLOBAL));

    build_fake_loaded_pe(1);
    CHECK(swyp_pe_collect_identity_ranges(g_fake_loaded_pe, sizeof(g_fake_loaded_pe), ranges, 8u, &range_count) ==
          SWYP_ERR_DENIED);
}

static void test_uefi_takeover_prepared_retry(void) {
    uint8_t memory_map[256];
    EFI_BOOT_SERVICES boot_services = {0};
    EFI_SYSTEM_TABLE system_table = {0};
    SwypUefiBootstrapArena arena;
    SwypUefiTakeover takeover;
    SwypBootInfo boot_info;
    SwypStatus prepare_status;
    EFI_HANDLE image_handle = (EFI_HANDLE)(uintptr_t)UINT64_C(0x1234);
    EFI_CONFIGURATION_TABLE configuration;
    uint64_t physical = 0u;
    uint64_t flags = 0u;
    uint64_t page_size = 0u;
    uint64_t image_base = (uint64_t)(uintptr_t)g_fake_loaded_pe;
    uint64_t arena_base;

    memset(&g_fake_uefi_boot, 0, sizeof(g_fake_uefi_boot));
    memset(&g_fake_uefi_pages, 0, sizeof(g_fake_uefi_pages));
    build_fake_loaded_pe(0);
    build_fake_rsdp();
    configuration = fake_acpi_configuration();
    g_fake_uefi_boot.include_takeover_ranges = 1u;
    boot_services.AllocatePages = fake_uefi_allocate_pages;
    boot_services.FreePages = fake_uefi_free_pages;
    boot_services.GetMemoryMap = fake_uefi_get_memory_map;
    boot_services.ExitBootServices = fake_uefi_exit_boot_services;
    boot_services.HandleProtocol = fake_uefi_handle_protocol;
    system_table.BootServices = &boot_services;
    system_table.NumberOfTableEntries = 1u;
    system_table.ConfigurationTable = &configuration;
    g_fake_uefi_boot.fail_first_exit = 1u;
    g_fake_uefi_boot.include_takeover_ranges = 1u;

    CHECK(swyp_uefi_bootstrap_arena_init(&system_table, &arena, 24u, 4u) == SWYP_OK);
    arena_base = arena.physical_base;
    CHECK(swyp_uefi_takeover_init(image_handle, &system_table, &arena, &takeover) == SWYP_OK);
    swyp_boot_info_init(&boot_info, SWYP_ARCH_X86_64, SWYP_FIRMWARE_UEFI, (uint64_t)(uintptr_t)&system_table);
    CHECK(swyp_uefi_capture_acpi_root(&system_table, &boot_info) == SWYP_OK);
    CHECK(swyp_uefi_capture_memory_map(&system_table, memory_map, sizeof(memory_map), &boot_info) == EFI_SUCCESS);
    prepare_status = swyp_uefi_takeover_prepare_exit(&takeover, &boot_info);
    if (prepare_status != SWYP_OK) {
        fprintf(stderr, "UEFI takeover prepare stage=%d status=%d\n", (int)takeover.stage, (int)prepare_status);
    }
    CHECK(prepare_status == SWYP_OK);
    if (prepare_status == SWYP_OK) {
        CHECK(swyp_kernel_takeover_destroy_unactivated(&takeover.takeover) == SWYP_OK);
    }
    g_fake_uefi_boot.get_map_calls = 0u;
    g_fake_uefi_boot.exit_calls = 0u;
    g_fake_uefi_boot.last_exit_key = 0u;
    swyp_boot_info_init(&boot_info, SWYP_ARCH_X86_64, SWYP_FIRMWARE_UEFI, (uint64_t)(uintptr_t)&system_table);
    CHECK(swyp_uefi_exit_boot_services_prepared(image_handle, &system_table, memory_map, sizeof(memory_map),
                                                &boot_info, 4u, swyp_uefi_takeover_prepare_exit, &takeover) ==
          EFI_SUCCESS);
    CHECK(g_fake_uefi_boot.get_map_calls == 2u && g_fake_uefi_boot.exit_calls == 2u);
    CHECK(takeover.takeover.prepared != 0u && takeover.takeover.activated == 0u);
    CHECK(swyp_uefi_takeover_root_physical(&takeover) != 0u);
    CHECK(swyp_uefi_takeover_stack_top(&takeover) == swyp_uefi_bootstrap_stack_top(&arena));
    CHECK(swyp_x86_64_kernel_root_query(&takeover.takeover.root, image_base + 0x1000u, &physical, &flags,
                                        &page_size) == SWYP_OK);
    CHECK(physical == image_base + 0x1000u && (flags & SWYP_MMU_EXECUTE) != 0u &&
          (flags & SWYP_MMU_WRITE) == 0u);
    CHECK(swyp_x86_64_kernel_root_query(&takeover.takeover.root, arena_base, &physical, &flags, &page_size) ==
          SWYP_OK);
    CHECK(physical == arena_base && (flags & SWYP_MMU_WRITE) != 0u && (flags & SWYP_MMU_EXECUTE) == 0u);
    CHECK(swyp_x86_64_kernel_root_query(&takeover.takeover.root, swyp_uefi_bootstrap_guard_base(&arena), &physical,
                                        &flags, &page_size) == SWYP_ERR_NOT_FOUND);
    CHECK(swyp_x86_64_kernel_root_query(&takeover.takeover.root, swyp_uefi_bootstrap_ist_base(&arena), &physical,
                                        &flags, &page_size) == SWYP_OK);
    CHECK(swyp_x86_64_kernel_root_query(&takeover.takeover.root, swyp_uefi_bootstrap_ist_guard_base(&arena), &physical,
                                        &flags, &page_size) == SWYP_ERR_NOT_FOUND);
    CHECK(swyp_x86_64_kernel_root_query(&takeover.takeover.root, swyp_uefi_bootstrap_stack_base(&arena), &physical,
                                        &flags, &page_size) == SWYP_OK);
    CHECK(swyp_x86_64_kernel_root_query(&takeover.takeover.root, SWYP_X86_64_DIRECT_MAP_BASE + UINT64_C(0x200000),
                                        &physical, &flags, &page_size) == SWYP_OK);
    CHECK(physical == UINT64_C(0x200000) && (flags & SWYP_MMU_WRITE) != 0u &&
          (flags & SWYP_MMU_EXECUTE) == 0u);
    CHECK(swyp_x86_64_kernel_root_query(&takeover.takeover.root,
                                        SWYP_X86_64_DIRECT_MAP_BASE + (uint64_t)(uintptr_t)g_fake_acpi_page,
                                        &physical, &flags, &page_size) == SWYP_OK);
    CHECK(physical == (uint64_t)(uintptr_t)g_fake_acpi_page && (flags & SWYP_MMU_READ) != 0u &&
          (flags & (SWYP_MMU_WRITE | SWYP_MMU_EXECUTE | SWYP_MMU_USER | SWYP_MMU_DEVICE)) == 0u);

    CHECK(swyp_kernel_takeover_destroy_unactivated(&takeover.takeover) == SWYP_OK);
    CHECK(swyp_uefi_bootstrap_arena_release(&system_table, &arena) == SWYP_OK);
}

static void test_kernel_handoff_validation(void) {
    EFI_MEMORY_DESCRIPTOR descriptor = {0};
    SwypPhysicalMemoryMap memory_map = {0};
    SwypUefiPageAllocator allocator_state;
    SwypBootInfo boot_info;
    descriptor.Type = (EFI_UINT32)EfiConventionalMemory;
    descriptor.PhysicalStart = UINT64_C(0x200000);
    descriptor.NumberOfPages = 16u;
    memory_map.source = SWYP_MEMORY_MAP_UEFI;
    memory_map.entries_address = (uint64_t)(uintptr_t)&descriptor;
    memory_map.buffer_bytes = sizeof(descriptor);
    memory_map.entry_count = 1u;
    memory_map.entry_stride = sizeof(descriptor);
    CHECK(swyp_uefi_page_allocator_init(&allocator_state, &memory_map) == SWYP_OK);
    swyp_boot_info_init(&boot_info, SWYP_ARCH_X86_64, SWYP_FIRMWARE_UEFI, UINT64_C(0x1000));
    boot_info.physical_memory = memory_map;
    boot_info.boot_flags = SWYP_BOOT_FLAG_EXITED_BOOT_SERVICES | SWYP_BOOT_FLAG_PAGE_ALLOCATOR_READY |
                           SWYP_BOOT_FLAG_KERNEL_ROOT_ACTIVE | SWYP_BOOT_FLAG_DIRECT_MAP_READY |
                           SWYP_BOOT_FLAG_PRIVILEGE_READY | SWYP_BOOT_FLAG_EMERGENCY_IDT_READY |
                           SWYP_BOOT_FLAG_TRAP_ABI_READY;
    CHECK(swyp_kernel_validate_handoff(&boot_info, swyp_uefi_page_allocator_contract(&allocator_state)) == SWYP_OK);
    boot_info.boot_flags &= ~SWYP_BOOT_FLAG_KERNEL_ROOT_ACTIVE;
    CHECK(swyp_kernel_validate_handoff(&boot_info, swyp_uefi_page_allocator_contract(&allocator_state)) ==
          SWYP_ERR_CORRUPT);
    boot_info.boot_flags |= SWYP_BOOT_FLAG_KERNEL_ROOT_ACTIVE;
    boot_info.boot_flags &= ~SWYP_BOOT_FLAG_DIRECT_MAP_READY;
    CHECK(swyp_kernel_validate_handoff(&boot_info, swyp_uefi_page_allocator_contract(&allocator_state)) ==
          SWYP_ERR_CORRUPT);
    boot_info.boot_flags |= SWYP_BOOT_FLAG_DIRECT_MAP_READY;
    boot_info.boot_flags &= ~SWYP_BOOT_FLAG_PRIVILEGE_READY;
    CHECK(swyp_kernel_validate_handoff(&boot_info, swyp_uefi_page_allocator_contract(&allocator_state)) ==
          SWYP_ERR_CORRUPT);
    boot_info.boot_flags |= SWYP_BOOT_FLAG_PRIVILEGE_READY;
    boot_info.boot_flags &= ~SWYP_BOOT_FLAG_EMERGENCY_IDT_READY;
    CHECK(swyp_kernel_validate_handoff(&boot_info, swyp_uefi_page_allocator_contract(&allocator_state)) ==
          SWYP_ERR_CORRUPT);
    boot_info.boot_flags |= SWYP_BOOT_FLAG_EMERGENCY_IDT_READY;
    boot_info.boot_flags &= ~SWYP_BOOT_FLAG_TRAP_ABI_READY;
    CHECK(swyp_kernel_validate_handoff(&boot_info, swyp_uefi_page_allocator_contract(&allocator_state)) ==
          SWYP_ERR_CORRUPT);
}

#define TEST_X86_PAGE_POOL_PAGES 64u

typedef struct FakeX86PagePool {
    _Alignas(4096) uint8_t pages[TEST_X86_PAGE_POOL_PAGES][4096];
    uint8_t used[TEST_X86_PAGE_POOL_PAGES];
    uint32_t alloc_calls;
    uint32_t release_calls;
    uint32_t fail_on_alloc_call;
} FakeX86PagePool;

typedef struct FakeX86Hardware {
    FakeX86PagePool *pool;
    uint64_t current_root;
    uint64_t last_invalidated;
    uint32_t activations;
    uint32_t invalidations;
} FakeX86Hardware;

static uint64_t fake_x86_page_physical(uint32_t index) {
    return UINT64_C(0x100000) + (uint64_t)index * SWYP_X86_64_PAGE_SIZE;
}

static int fake_x86_page_index(uint64_t physical_address, uint32_t *index) {
    uint64_t relative;
    if (physical_address < UINT64_C(0x100000)) {
        return 0;
    }
    relative = physical_address - UINT64_C(0x100000);
    if ((relative & (SWYP_X86_64_PAGE_SIZE - 1u)) != 0u ||
        relative / SWYP_X86_64_PAGE_SIZE >= TEST_X86_PAGE_POOL_PAGES) {
        return 0;
    }
    if (index != NULL) {
        *index = (uint32_t)(relative / SWYP_X86_64_PAGE_SIZE);
    }
    return 1;
}

static uint32_t fake_x86_used_pages(const FakeX86PagePool *pool) {
    uint32_t count = 0u;
    uint32_t i;
    for (i = 0; i < TEST_X86_PAGE_POOL_PAGES; ++i) {
        if (pool->used[i] != 0u) {
            count += 1u;
        }
    }
    return count;
}

static SwypStatus fake_x86_allocate(void *context, uint64_t page_count, uint64_t alignment_pages,
                                    uint64_t *physical_address) {
    FakeX86PagePool *pool = (FakeX86PagePool *)context;
    uint32_t i;
    if (pool == NULL || physical_address == NULL || page_count != 1u || alignment_pages != 1u) {
        return SWYP_ERR_INVALID;
    }
    pool->alloc_calls += 1u;
    if (pool->fail_on_alloc_call != 0u && pool->alloc_calls == pool->fail_on_alloc_call) {
        return SWYP_ERR_NO_SPACE;
    }
    for (i = 0; i < TEST_X86_PAGE_POOL_PAGES; ++i) {
        if (pool->used[i] == 0u) {
            pool->used[i] = 1u;
            memset(pool->pages[i], 0, sizeof(pool->pages[i]));
            *physical_address = fake_x86_page_physical(i);
            return SWYP_OK;
        }
    }
    return SWYP_ERR_NO_SPACE;
}

static SwypStatus fake_x86_release(void *context, uint64_t physical_address, uint64_t page_count) {
    FakeX86PagePool *pool = (FakeX86PagePool *)context;
    uint32_t index;
    if (pool == NULL || page_count != 1u || !fake_x86_page_index(physical_address, &index) || pool->used[index] == 0u) {
        return SWYP_ERR_INVALID;
    }
    pool->used[index] = 0u;
    pool->release_calls += 1u;
    memset(pool->pages[index], 0, sizeof(pool->pages[index]));
    return SWYP_OK;
}

static const SwypPageAllocatorOps fake_x86_allocator_ops = {
    .allocate = fake_x86_allocate,
    .release = fake_x86_release,
};

static void *fake_x86_physical_to_virtual(void *context, uint64_t physical_address) {
    FakeX86Hardware *hardware = (FakeX86Hardware *)context;
    uint32_t index;
    if (hardware == NULL || hardware->pool == NULL || !fake_x86_page_index(physical_address, &index) ||
        hardware->pool->used[index] == 0u) {
        return NULL;
    }
    return hardware->pool->pages[index];
}

static SwypStatus fake_x86_activate_root(void *context, uint64_t pml4_physical) {
    FakeX86Hardware *hardware = (FakeX86Hardware *)context;
    uint32_t index;
    if (hardware == NULL || hardware->pool == NULL || !fake_x86_page_index(pml4_physical, &index) ||
        hardware->pool->used[index] == 0u) {
        return SWYP_ERR_INVALID;
    }
    hardware->current_root = pml4_physical;
    hardware->activations += 1u;
    return SWYP_OK;
}

static uint64_t fake_x86_current_root(void *context) {
    FakeX86Hardware *hardware = (FakeX86Hardware *)context;
    return hardware == NULL ? 0u : hardware->current_root;
}

static void fake_x86_invalidate_page(void *context, uint64_t virtual_address) {
    FakeX86Hardware *hardware = (FakeX86Hardware *)context;
    if (hardware != NULL) {
        hardware->invalidations += 1u;
        hardware->last_invalidated = virtual_address;
    }
}

static const SwypX86AddressSpaceHardwareOps fake_x86_hardware_ops = {
    .physical_to_virtual = fake_x86_physical_to_virtual,
    .activate_root = fake_x86_activate_root,
    .current_root = fake_x86_current_root,
    .invalidate_page = fake_x86_invalidate_page,
};

static void test_x86_address_spaces(void) {
    FakeX86PagePool pool = {0};
    FakeX86Hardware hardware = {.pool = &pool};
    SwypPageAllocator allocator = {.context = &pool, .ops = &fake_x86_allocator_ops};
    SwypX86AddressSpace space;
    SwypAddressSpace *contract;
    uint64_t physical = 0u;
    uint64_t flags = 0u;

    CHECK(swyp_x86_64_address_space_init(&space, &allocator, &hardware, &fake_x86_hardware_ops, 700u) == SWYP_OK);
    CHECK(space.pml4_physical != 0u && fake_x86_used_pages(&pool) == 1u);
    contract = swyp_x86_64_address_space_contract(&space);
    CHECK(contract != NULL && contract->ops != NULL);
    CHECK(contract->ops->map(contract->context, UINT64_C(0x40000000), UINT64_C(0x300000), 2u,
                             SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_USER | SWYP_MMU_DEVICE) == SWYP_OK);
    CHECK(fake_x86_used_pages(&pool) == 4u);
    CHECK(swyp_x86_64_address_space_query(&space, UINT64_C(0x40000123), &physical, &flags) == SWYP_OK);
    CHECK(physical == UINT64_C(0x300123));
    CHECK((flags & (SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_USER | SWYP_MMU_DEVICE)) ==
          (SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_USER | SWYP_MMU_DEVICE));
    CHECK((flags & (SWYP_MMU_EXECUTE | SWYP_MMU_GLOBAL)) == 0u);
    CHECK(contract->ops->map(contract->context, UINT64_C(0x40000000), UINT64_C(0x500000), 1u,
                             SWYP_MMU_READ | SWYP_MMU_USER) == SWYP_ERR_DENIED);
    CHECK(contract->ops->map(contract->context, UINT64_C(0x40000001), UINT64_C(0x500000), 1u,
                             SWYP_MMU_READ | SWYP_MMU_USER) == SWYP_ERR_INVALID);
    CHECK(contract->ops->map(contract->context, UINT64_C(0x40002000), UINT64_C(0x500000), 1u,
                             SWYP_MMU_WRITE | SWYP_MMU_USER) == SWYP_ERR_INVALID);
    CHECK(contract->ops->map(contract->context, UINT64_C(0xffff800000000000), UINT64_C(0x500000), 1u,
                             SWYP_MMU_READ) == SWYP_ERR_INVALID);

    CHECK(contract->ops->activate(contract->context) == SWYP_OK);
    CHECK(hardware.current_root == space.pml4_physical && hardware.activations == 1u);
    CHECK(contract->ops->protect(contract->context, UINT64_C(0x40000000), 2u,
                                 SWYP_MMU_READ | SWYP_MMU_USER | SWYP_MMU_DEVICE) == SWYP_OK);
    CHECK(hardware.invalidations == 2u && hardware.last_invalidated == UINT64_C(0x40001000));
    CHECK(swyp_x86_64_address_space_query(&space, UINT64_C(0x40000000), &physical, &flags) == SWYP_OK);
    CHECK((flags & SWYP_MMU_WRITE) == 0u && (flags & SWYP_MMU_READ) != 0u);
    CHECK(contract->ops->unmap(contract->context, UINT64_C(0x40000000), 2u) == SWYP_OK);
    CHECK(hardware.invalidations == 4u && fake_x86_used_pages(&pool) == 1u);
    CHECK(swyp_x86_64_address_space_query(&space, UINT64_C(0x40000000), &physical, &flags) == SWYP_ERR_NOT_FOUND);
    CHECK(swyp_x86_64_address_space_destroy(&space) == SWYP_ERR_DENIED);
    hardware.current_root = 0u;
    CHECK(swyp_x86_64_address_space_destroy(&space) == SWYP_OK);
    CHECK(fake_x86_used_pages(&pool) == 0u);
}

static void test_x86_address_space_transaction_rollback(void) {
    FakeX86PagePool pool = {0};
    FakeX86Hardware hardware = {.pool = &pool};
    SwypPageAllocator allocator = {.context = &pool, .ops = &fake_x86_allocator_ops};
    SwypX86AddressSpace space;
    SwypAddressSpace *contract;
    uint64_t physical = 0u;
    uint64_t flags = 0u;

    CHECK(swyp_x86_64_address_space_init(&space, &allocator, &hardware, &fake_x86_hardware_ops, 701u) == SWYP_OK);
    contract = swyp_x86_64_address_space_contract(&space);
    CHECK(contract != NULL);
    /* Root allocation is call 1. Mapping 0x1ff000 then 0x200000 needs PDPT,
       PD, first PT and then a second PT; fail exactly on the second PT. */
    pool.fail_on_alloc_call = 5u;
    CHECK(contract->ops->map(contract->context, UINT64_C(0x001ff000), UINT64_C(0x500000), 2u,
                             SWYP_MMU_READ | SWYP_MMU_USER) == SWYP_ERR_NO_SPACE);
    CHECK(fake_x86_used_pages(&pool) == 1u);
    CHECK(swyp_x86_64_address_space_query(&space, UINT64_C(0x001ff000), &physical, &flags) == SWYP_ERR_NOT_FOUND);
    CHECK(swyp_x86_64_address_space_query(&space, UINT64_C(0x00200000), &physical, &flags) == SWYP_ERR_NOT_FOUND);
    pool.fail_on_alloc_call = 0u;
    CHECK(swyp_x86_64_address_space_destroy(&space) == SWYP_OK);
    CHECK(fake_x86_used_pages(&pool) == 0u);
}

static void test_x86_address_space_isolation(void) {
    FakeX86PagePool pool = {0};
    FakeX86Hardware hardware = {.pool = &pool};
    SwypPageAllocator allocator = {.context = &pool, .ops = &fake_x86_allocator_ops};
    SwypX86AddressSpace left;
    SwypX86AddressSpace right;
    uint64_t left_physical = 0u;
    uint64_t right_physical = 0u;
    uint64_t flags = 0u;

    CHECK(swyp_x86_64_address_space_init(&left, &allocator, &hardware, &fake_x86_hardware_ops, 710u) == SWYP_OK);
    CHECK(swyp_x86_64_address_space_init(&right, &allocator, &hardware, &fake_x86_hardware_ops, 711u) == SWYP_OK);
    CHECK(left.pml4_physical != right.pml4_physical);
    CHECK(left.contract.ops->map(left.contract.context, UINT64_C(0x50000000), UINT64_C(0x600000), 1u,
                                 SWYP_MMU_READ | SWYP_MMU_USER) == SWYP_OK);
    CHECK(right.contract.ops->map(right.contract.context, UINT64_C(0x50000000), UINT64_C(0x700000), 1u,
                                  SWYP_MMU_READ | SWYP_MMU_USER) == SWYP_OK);
    CHECK(swyp_x86_64_address_space_query(&left, UINT64_C(0x50000000), &left_physical, &flags) == SWYP_OK);
    CHECK(swyp_x86_64_address_space_query(&right, UINT64_C(0x50000000), &right_physical, &flags) == SWYP_OK);
    CHECK(left_physical == UINT64_C(0x600000) && right_physical == UINT64_C(0x700000));
    CHECK(left.contract.ops->unmap(left.contract.context, UINT64_C(0x50000000), 1u) == SWYP_OK);
    CHECK(swyp_x86_64_address_space_query(&right, UINT64_C(0x50000000), &right_physical, &flags) == SWYP_OK);
    CHECK(right_physical == UINT64_C(0x700000));
    CHECK(swyp_x86_64_address_space_destroy(&left) == SWYP_OK);
    CHECK(swyp_x86_64_address_space_destroy(&right) == SWYP_OK);
    CHECK(fake_x86_used_pages(&pool) == 0u);
}

static void test_x86_address_space_inherits_kernel_supervisor_root(void) {
    FakeX86PagePool pool = {0};
    FakeX86Hardware hardware = {.pool = &pool};
    SwypPageAllocator allocator = {.context = &pool, .ops = &fake_x86_allocator_ops};
    SwypX86KernelRoot kernel_root;
    SwypX86AddressSpace driver;
    SwypAddressSpace *contract;
    uint32_t kernel_pages;
    uint64_t physical = 0u;
    uint64_t flags = 0u;
    uint64_t kernel_identity = UINT64_C(0x200000);

    CHECK(swyp_x86_64_kernel_root_init(&kernel_root, &allocator, &hardware, &fake_x86_hardware_ops,
                                       SWYP_X86_64_DIRECT_MAP_BASE, UINT64_C(0x40000000)) == SWYP_OK);
    CHECK(swyp_x86_64_kernel_root_map_identity(&kernel_root, kernel_identity, SWYP_X86_64_PAGE_SIZE,
                                               SWYP_MMU_READ | SWYP_MMU_EXECUTE | SWYP_MMU_GLOBAL, 0) == SWYP_OK);
    CHECK(swyp_x86_64_kernel_root_map_direct(&kernel_root, UINT64_C(0x200000), SWYP_X86_64_LARGE_PAGE_SIZE,
                                             SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_GLOBAL, 1) == SWYP_OK);
    kernel_pages = fake_x86_used_pages(&pool);
    CHECK(kernel_pages > 1u);

    CHECK(swyp_x86_64_address_space_init(&driver, &allocator, &hardware, &fake_x86_hardware_ops, 720u) == SWYP_OK);
    CHECK(swyp_x86_64_address_space_inherit_supervisor_root(&driver, kernel_root.pml4_physical) == SWYP_OK);
    CHECK(swyp_x86_64_address_space_pml4_shared(&driver, 0u) != 0);
    CHECK(swyp_x86_64_address_space_pml4_shared(&driver, 256u) != 0);
    CHECK(swyp_x86_64_address_space_query(&driver, kernel_identity, &physical, &flags) == SWYP_OK);
    CHECK(physical == kernel_identity && (flags & SWYP_MMU_EXECUTE) != 0u && (flags & SWYP_MMU_USER) == 0u);

    contract = swyp_x86_64_address_space_contract(&driver);
    CHECK(contract != NULL && contract->ops != NULL);
    CHECK(contract->ops->map(contract->context, UINT64_C(0x300000), UINT64_C(0x800000), 1u,
                             SWYP_MMU_READ | SWYP_MMU_USER) == SWYP_ERR_INVALID);
    CHECK(contract->ops->unmap(contract->context, kernel_identity, 1u) == SWYP_ERR_INVALID);
    CHECK(contract->ops->protect(contract->context, kernel_identity, 1u,
                                 SWYP_MMU_READ | SWYP_MMU_USER) == SWYP_ERR_INVALID);
    CHECK(contract->ops->map(contract->context, SWYP_X86_DRIVER_RUNTIME_VA_BASE, UINT64_C(0x900000), 1u,
                             SWYP_MMU_READ | SWYP_MMU_USER) == SWYP_OK);
    CHECK(contract->ops->unmap(contract->context, SWYP_X86_DRIVER_RUNTIME_VA_BASE, 1u) == SWYP_OK);

    CHECK(swyp_x86_64_address_space_destroy(&driver) == SWYP_OK);
    CHECK(fake_x86_used_pages(&pool) == kernel_pages);
    CHECK(swyp_x86_64_kernel_root_query(&kernel_root, kernel_identity, &physical, &flags, &(uint64_t){0}) == SWYP_OK);
    CHECK(physical == kernel_identity);
    CHECK(swyp_x86_64_kernel_root_destroy(&kernel_root) == SWYP_OK);
    CHECK(fake_x86_used_pages(&pool) == 0u);
}

static void test_x86_kernel_root_direct_map(void) {
    FakeX86PagePool pool = {0};
    FakeX86Hardware hardware = {.pool = &pool};
    SwypPageAllocator allocator = {.context = &pool, .ops = &fake_x86_allocator_ops};
    SwypX86KernelRoot root;
    uint64_t physical = 0u;
    uint64_t flags = 0u;
    uint64_t page_size = 0u;
    uint64_t direct_va = SWYP_X86_64_DIRECT_MAP_BASE + UINT64_C(0x200000);

    CHECK(swyp_x86_64_kernel_root_init(&root, &allocator, &hardware, &fake_x86_hardware_ops,
                                       SWYP_X86_64_DIRECT_MAP_BASE, UINT64_C(0x100000000)) == SWYP_OK);
    CHECK(fake_x86_used_pages(&pool) == 1u);
    CHECK(swyp_x86_64_kernel_root_map_direct(&root, UINT64_C(0x200000), UINT64_C(0x400000),
                                             SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_GLOBAL, 1) == SWYP_OK);
    CHECK(swyp_x86_64_kernel_root_query(&root, direct_va + UINT64_C(0x12345), &physical, &flags,
                                        &page_size) == SWYP_OK);
    CHECK(physical == UINT64_C(0x212345));
    CHECK(page_size == SWYP_X86_64_LARGE_PAGE_SIZE);
    CHECK((flags & (SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_GLOBAL)) ==
          (SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_GLOBAL));
    CHECK((flags & (SWYP_MMU_EXECUTE | SWYP_MMU_USER)) == 0u);

    CHECK(swyp_x86_64_kernel_root_map_identity(&root, UINT64_C(0x123000), UINT64_C(0x3000),
                                               SWYP_MMU_READ | SWYP_MMU_EXECUTE | SWYP_MMU_GLOBAL, 1) == SWYP_OK);
    CHECK(swyp_x86_64_kernel_root_query(&root, UINT64_C(0x124321), &physical, &flags, &page_size) == SWYP_OK);
    CHECK(physical == UINT64_C(0x124321));
    CHECK(page_size == SWYP_X86_64_PAGE_SIZE);
    CHECK((flags & (SWYP_MMU_READ | SWYP_MMU_EXECUTE | SWYP_MMU_GLOBAL)) ==
          (SWYP_MMU_READ | SWYP_MMU_EXECUTE | SWYP_MMU_GLOBAL));
    CHECK((flags & SWYP_MMU_WRITE) == 0u);

    CHECK(swyp_x86_64_kernel_root_map_identity(&root, UINT64_C(0x180000), SWYP_X86_64_PAGE_SIZE,
                                               SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_EXECUTE, 0) ==
          SWYP_ERR_INVALID);
    CHECK(root.failed == 0u);

    CHECK(swyp_x86_64_kernel_root_activate(&root) == SWYP_OK);
    CHECK(hardware.current_root == root.pml4_physical && root.active != 0u);
    CHECK(swyp_x86_64_kernel_root_destroy(&root) == SWYP_ERR_DENIED);
    hardware.current_root = 0u;
    CHECK(swyp_x86_64_kernel_root_destroy(&root) == SWYP_OK);
    CHECK(fake_x86_used_pages(&pool) == 0u);
}

static void test_x86_kernel_root_failed_map_is_destroyable(void) {
    FakeX86PagePool pool = {0};
    FakeX86Hardware hardware = {.pool = &pool};
    SwypPageAllocator allocator = {.context = &pool, .ops = &fake_x86_allocator_ops};
    SwypX86KernelRoot root;

    CHECK(swyp_x86_64_kernel_root_init(&root, &allocator, &hardware, &fake_x86_hardware_ops,
                                       SWYP_X86_64_DIRECT_MAP_BASE, UINT64_C(0x40000000)) == SWYP_OK);
    CHECK(swyp_x86_64_kernel_root_map_direct(&root, UINT64_C(0x200000), SWYP_X86_64_LARGE_PAGE_SIZE,
                                             SWYP_MMU_READ | SWYP_MMU_WRITE, 1) == SWYP_OK);
    CHECK(swyp_x86_64_kernel_root_map_direct(&root, UINT64_C(0x200000), SWYP_X86_64_LARGE_PAGE_SIZE,
                                             SWYP_MMU_READ | SWYP_MMU_WRITE, 1) == SWYP_ERR_DENIED);
    CHECK(root.failed != 0u);
    CHECK(swyp_x86_64_kernel_root_activate(&root) == SWYP_ERR_INVALID);
    CHECK(swyp_x86_64_kernel_root_destroy(&root) == SWYP_OK);
    CHECK(fake_x86_used_pages(&pool) == 0u);
}

static void test_kernel_takeover_plan(void) {
    FakeX86PagePool pool = {0};
    FakeX86Hardware hardware = {.pool = &pool};
    SwypPageAllocator allocator = {.context = &pool, .ops = &fake_x86_allocator_ops};
    SwypKernelTakeover takeover;
    SwypKernelPhysicalRange direct_ranges[] = {
        {UINT64_C(0x100000), UINT64_C(0x400000), SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_GLOBAL},
        {UINT64_C(0x800000), UINT64_C(0x200000), SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_GLOBAL},
    };
    SwypKernelIdentityRange identity_ranges[] = {
        {UINT64_C(0x100000), UINT64_C(0x2000), SWYP_MMU_READ | SWYP_MMU_EXECUTE | SWYP_MMU_GLOBAL},
        {UINT64_C(0x180000), UINT64_C(0x2000), SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_GLOBAL},
    };
    SwypX86NativeMmu *native_mmu;
    const SwypX86AddressSpaceHardwareOps *native_ops;
    uint64_t physical = 0u;
    uint64_t flags = 0u;
    uint64_t page_size = 0u;

    CHECK(swyp_kernel_takeover_prepare(&takeover, &allocator, &hardware, &fake_x86_hardware_ops, direct_ranges,
                                       2u, identity_ranges, 2u) == SWYP_OK);
    CHECK(takeover.prepared != 0u && takeover.activated == 0u);
    CHECK(swyp_x86_64_kernel_root_query(&takeover.root, SWYP_X86_64_DIRECT_MAP_BASE + UINT64_C(0x200000),
                                        &physical, &flags, &page_size) == SWYP_OK);
    CHECK(physical == UINT64_C(0x200000));
    CHECK((flags & (SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_GLOBAL)) ==
          (SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_GLOBAL));
    CHECK((flags & SWYP_MMU_EXECUTE) == 0u);
    CHECK(swyp_x86_64_kernel_root_query(&takeover.root, UINT64_C(0x100000), &physical, &flags,
                                        &page_size) == SWYP_OK);
    CHECK(physical == UINT64_C(0x100000) && (flags & SWYP_MMU_EXECUTE) != 0u &&
          (flags & SWYP_MMU_WRITE) == 0u);

    native_mmu = swyp_kernel_takeover_native_mmu(&takeover);
    native_ops = swyp_kernel_takeover_native_ops(&takeover);
    CHECK(native_mmu != NULL && native_ops != NULL);
    CHECK(native_mmu->range_count == 2u);
    CHECK(native_ops->physical_to_virtual(native_mmu, UINT64_C(0x200000)) ==
          (void *)(uintptr_t)(SWYP_X86_64_DIRECT_MAP_BASE + UINT64_C(0x200000)));
    CHECK(native_ops->physical_to_virtual(native_mmu, UINT64_C(0x600000)) == NULL);

    CHECK(swyp_kernel_takeover_activate(&takeover) == SWYP_OK);
    CHECK(takeover.activated != 0u && hardware.current_root == takeover.root.pml4_physical);
    CHECK(swyp_kernel_takeover_activate(&takeover) == SWYP_ERR_INVALID);
}

static void test_kernel_takeover_unactivated_cleanup(void) {
    FakeX86PagePool pool = {0};
    FakeX86Hardware hardware = {.pool = &pool};
    SwypPageAllocator allocator = {.context = &pool, .ops = &fake_x86_allocator_ops};
    SwypKernelTakeover takeover;
    SwypKernelPhysicalRange direct_range = {
        UINT64_C(0x100000), UINT64_C(0x400000), SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_GLOBAL};

    CHECK(swyp_kernel_takeover_prepare(&takeover, &allocator, &hardware, &fake_x86_hardware_ops, &direct_range,
                                       1u, NULL, 0u) == SWYP_OK);
    CHECK(fake_x86_used_pages(&pool) != 0u);
    CHECK(swyp_kernel_takeover_destroy_unactivated(&takeover) == SWYP_OK);
    CHECK(fake_x86_used_pages(&pool) == 0u && takeover.prepared == 0u);
}

static void test_kernel_takeover_external_activation_confirmation(void) {
    FakeX86PagePool pool = {0};
    FakeX86Hardware hardware = {.pool = &pool};
    SwypPageAllocator allocator = {.context = &pool, .ops = &fake_x86_allocator_ops};
    SwypKernelTakeover takeover;
    SwypKernelPhysicalRange direct_range = {
        UINT64_C(0x100000), UINT64_C(0x400000), SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_GLOBAL};

    CHECK(swyp_kernel_takeover_prepare(&takeover, &allocator, &hardware, &fake_x86_hardware_ops, &direct_range,
                                       1u, NULL, 0u) == SWYP_OK);
    CHECK(swyp_kernel_takeover_confirm_external_activation(&takeover) == SWYP_ERR_DENIED);
    hardware.current_root = takeover.root.pml4_physical;
    CHECK(swyp_kernel_takeover_confirm_external_activation(&takeover) == SWYP_OK);
    CHECK(takeover.activated != 0u && takeover.root.active != 0u);
}

static void test_x86_native_backend_nonprivileged_contracts(void) {
    _Alignas(4096) uint8_t direct_page[4096] = {0};
    _Alignas(4096) uint8_t lapic_page[4096] = {0};
    _Alignas(4096) uint8_t ioapic_page[4096] = {0};
    SwypX86NativeMmu native_mmu;
    const SwypX86AddressSpaceHardwareOps *mmu_ops;
    SwypX86ApicMmio apic_mmio;
    const SwypX86ApicHardwareOps *apic_ops;
    uint64_t physical_base = UINT64_C(0x1000);
    uint64_t direct_base = (uint64_t)(uintptr_t)direct_page - physical_base;
    uint32_t value = 0u;

    CHECK(swyp_x86_native_mmu_init(&native_mmu, direct_base, UINT64_C(0x2000)) == SWYP_OK);
    mmu_ops = swyp_x86_native_mmu_ops();
    CHECK(mmu_ops != NULL);
    CHECK(mmu_ops->physical_to_virtual(&native_mmu, physical_base) == direct_page);
    CHECK(mmu_ops->physical_to_virtual(&native_mmu, UINT64_C(0x2000)) == NULL);

    CHECK(swyp_x86_native_mmu_init_sparse(&native_mmu, direct_base, UINT64_C(0x4000)) == SWYP_OK);
    CHECK(swyp_x86_native_mmu_add_range(&native_mmu, UINT64_C(0x1000), UINT64_C(0x1000)) == SWYP_OK);
    CHECK(swyp_x86_native_mmu_add_range(&native_mmu, UINT64_C(0x3000), UINT64_C(0x1000)) == SWYP_OK);
    CHECK(mmu_ops->physical_to_virtual(&native_mmu, UINT64_C(0x1000)) == direct_page);
    CHECK(mmu_ops->physical_to_virtual(&native_mmu, UINT64_C(0x2000)) == NULL);
    CHECK(swyp_x86_native_mmu_add_range(&native_mmu, UINT64_C(0x2000), UINT64_C(0x1000)) == SWYP_OK);
    CHECK(native_mmu.range_count == 1u && native_mmu.ranges[0].base == UINT64_C(0x1000) &&
          native_mmu.ranges[0].length == UINT64_C(0x3000));
    CHECK(swyp_x86_native_mmu_remove_range(&native_mmu, UINT64_C(0x2000), UINT64_C(0x1000)) == SWYP_OK);
    CHECK(native_mmu.range_count == 2u);
    CHECK(native_mmu.ranges[0].base == UINT64_C(0x1000) && native_mmu.ranges[0].length == UINT64_C(0x1000));
    CHECK(native_mmu.ranges[1].base == UINT64_C(0x3000) && native_mmu.ranges[1].length == UINT64_C(0x1000));
    CHECK(mmu_ops->physical_to_virtual(&native_mmu, UINT64_C(0x2000)) == NULL);
    CHECK(swyp_x86_native_mmu_add_range(&native_mmu, UINT64_C(0x2000), UINT64_C(0x1000)) == SWYP_OK);
    CHECK(native_mmu.range_count == 1u && native_mmu.ranges[0].length == UINT64_C(0x3000));

    CHECK(swyp_x86_apic_mmio_init(&apic_mmio, lapic_page, ioapic_page) == SWYP_OK);
    apic_ops = swyp_x86_apic_mmio_ops();
    CHECK(apic_ops != NULL);
    *(uint32_t *)(void *)(ioapic_page + 0x10u) = UINT32_C(0xa5a55a5a);
    CHECK(apic_ops->ioapic_read(&apic_mmio, 0x12u, &value) == SWYP_OK);
    CHECK(*(uint32_t *)(void *)ioapic_page == 0x12u && value == UINT32_C(0xa5a55a5a));
    CHECK(apic_ops->ioapic_write(&apic_mmio, 0x13u, UINT32_C(0x55aa33cc)) == SWYP_OK);
    CHECK(*(uint32_t *)(void *)ioapic_page == 0x13u &&
          *(uint32_t *)(void *)(ioapic_page + 0x10u) == UINT32_C(0x55aa33cc));
    CHECK(apic_ops->lapic_write(&apic_mmio, 0xB0u, UINT32_C(0x1234)) == SWYP_OK);
    CHECK(*(uint32_t *)(void *)(lapic_page + 0xB0u) == UINT32_C(0x1234));
}

static void test_x86_platform_map_registry_failure_rolls_back(void) {
    FakeX86PagePool pool = {0};
    FakeX86Hardware hardware = {.pool = &pool};
    SwypPageAllocator allocator = {.context = &pool, .ops = &fake_x86_allocator_ops};
    SwypX86KernelRoot root;
    SwypX86NativeMmu native_mmu;
    volatile void *mapped = NULL;
    uint64_t physical = 0u;
    uint64_t flags = 0u;
    uint64_t page_size = 0u;
    uint64_t target_physical = UINT64_C(0x30000000);
    uint64_t target_virtual = SWYP_X86_64_DIRECT_MAP_BASE + target_physical;
    uint32_t i;
    uint32_t pages_before;

    CHECK(swyp_x86_64_kernel_root_init(&root, &allocator, &hardware, &fake_x86_hardware_ops,
                                       SWYP_X86_64_DIRECT_MAP_BASE, UINT64_C(0x40000000)) == SWYP_OK);
    CHECK(swyp_x86_64_kernel_root_activate(&root) == SWYP_OK);
    CHECK(swyp_x86_native_mmu_init_sparse(&native_mmu, SWYP_X86_64_DIRECT_MAP_BASE,
                                          UINT64_C(0x40000000)) == SWYP_OK);
    for (i = 0u; i < SWYP_X86_NATIVE_MMU_MAX_RANGES; ++i) {
        CHECK(swyp_x86_native_mmu_add_range(&native_mmu, UINT64_C(0x10000000) + (uint64_t)i * UINT64_C(0x2000),
                                            SWYP_X86_64_PAGE_SIZE) == SWYP_OK);
    }
    CHECK(native_mmu.range_count == SWYP_X86_NATIVE_MMU_MAX_RANGES);
    pages_before = fake_x86_used_pages(&pool);
    CHECK(swyp_x86_64_kernel_root_query(&root, target_virtual, &physical, &flags, &page_size) == SWYP_ERR_NOT_FOUND);
    CHECK(swyp_x86_platform_map_mmio(&root, &native_mmu, target_physical, SWYP_X86_64_PAGE_SIZE, &mapped) ==
          SWYP_ERR_NO_SPACE);
    CHECK(mapped == NULL);
    CHECK(swyp_x86_64_kernel_root_query(&root, target_virtual, &physical, &flags, &page_size) == SWYP_ERR_NOT_FOUND);
    CHECK(fake_x86_used_pages(&pool) == pages_before);
    CHECK(root.failed == 0u);
    hardware.current_root = 0u;
    CHECK(swyp_x86_64_kernel_root_destroy(&root) == SWYP_OK);
    CHECK(fake_x86_used_pages(&pool) == 0u);
}

static void test_x86_privilege_descriptors(void) {
    SwypX86PrivilegeState state;
    uint64_t rsp0 = UINT64_C(0xffff800000100000);
    uint64_t ist1 = UINT64_C(0xffff800000110000);
    uint64_t ist7 = UINT64_C(0xffff800000170000);
    uint64_t page_fault_handler = UINT64_C(0xffff800000200000);
    uint64_t breakpoint_handler = UINT64_C(0xffff800000201000);

    CHECK(swyp_x86_privilege_init(&state, rsp0) == SWYP_OK);
    CHECK(swyp_x86_privilege_validate(&state) == SWYP_OK);
    CHECK(state.tss.rsp0 == rsp0 && state.tss.io_map_base == sizeof(state.tss));
    CHECK(state.gdtr.base == (uint64_t)(uintptr_t)&state.gdt[0] &&
          state.gdtr.limit == sizeof(state.gdt) - 1u);
    CHECK(state.idtr.base == (uint64_t)(uintptr_t)&state.idt[0] &&
          state.idtr.limit == sizeof(state.idt) - 1u);

    CHECK(swyp_x86_privilege_set_ist(&state, 1u, ist1) == SWYP_OK);
    CHECK(swyp_x86_privilege_set_ist(&state, 7u, ist7) == SWYP_OK);
    CHECK(state.tss.ist1 == ist1 && state.tss.ist7 == ist7);
    CHECK(swyp_x86_privilege_set_ist(&state, 0u, ist1) == SWYP_ERR_INVALID);
    CHECK(swyp_x86_privilege_set_ist(&state, 8u, ist1) == SWYP_ERR_INVALID);
    CHECK(swyp_x86_privilege_set_rsp0(&state, rsp0 + 8u) == SWYP_ERR_INVALID);

    CHECK(swyp_x86_privilege_set_idt_gate(&state, 14u, page_fault_handler, 1u, 0u,
                                          SWYP_X86_IDT_GATE_INTERRUPT) == SWYP_OK);
    CHECK(swyp_x86_privilege_idt_handler(&state, 14u) == page_fault_handler);
    CHECK(state.idt[14].selector == SWYP_X86_SELECTOR_KERNEL_CODE && state.idt[14].ist == 1u &&
          state.idt[14].type_attributes == UINT8_C(0x8e));
    CHECK(swyp_x86_privilege_set_idt_gate(&state, 3u, breakpoint_handler, 0u, 3u,
                                          SWYP_X86_IDT_GATE_TRAP) == SWYP_OK);
    CHECK(state.idt[3].type_attributes == UINT8_C(0xef));
    CHECK(swyp_x86_privilege_validate(&state) == SWYP_OK);

    CHECK(swyp_x86_privilege_set_idt_gate(&state, 256u, page_fault_handler, 0u, 0u,
                                          SWYP_X86_IDT_GATE_INTERRUPT) == SWYP_ERR_INVALID);
    CHECK(swyp_x86_privilege_set_idt_gate(&state, 32u, UINT64_C(0x0000800000000000), 0u, 0u,
                                          SWYP_X86_IDT_GATE_INTERRUPT) == SWYP_ERR_INVALID);
    CHECK(swyp_x86_privilege_set_idt_gate(&state, 32u, page_fault_handler, 8u, 0u,
                                          SWYP_X86_IDT_GATE_INTERRUPT) == SWYP_ERR_INVALID);
    CHECK(swyp_x86_privilege_set_idt_gate(&state, 32u, page_fault_handler, 0u, 4u,
                                          SWYP_X86_IDT_GATE_INTERRUPT) == SWYP_ERR_INVALID);

    CHECK(swyp_x86_privilege_clear_idt_gate(&state, 14u) == SWYP_OK);
    CHECK(swyp_x86_privilege_idt_handler(&state, 14u) == 0u);
    CHECK(swyp_x86_privilege_validate(&state) == SWYP_OK);

    state.idt[3].selector = SWYP_X86_SELECTOR_USER_CODE;
    CHECK(swyp_x86_privilege_validate(&state) == SWYP_ERR_CORRUPT);
}

/* Real hardware sets the TSS busy bit when LTR loads the task register and the
   accessed bit of every segment descriptor it loads; the exception IDT is
   installed afterwards, so validation must accept both. Found by booting the
   EFI image under OVMF/QEMU, where boot halted before TRAP_ABI_READY. */
static void test_x86_privilege_accepts_busy_tss_after_ltr(void) {
    SwypX86PrivilegeState state;
    uint64_t access_mask = UINT64_C(0xff) << 40;
    uint64_t accessed = UINT64_C(1) << 40;
    CHECK(swyp_x86_privilege_init(&state, UINT64_C(0xffff800000100000)) == SWYP_OK);
    CHECK(swyp_x86_privilege_set_ist(&state, 1u, UINT64_C(0xffff800000110000)) == SWYP_OK);
    state.gdt[5] = (state.gdt[5] & ~access_mask) | (UINT64_C(0x8b) << 40);
    CHECK(swyp_x86_privilege_validate(&state) == SWYP_OK);
    /* Loading DS/SS/CS sets the descriptors' accessed bit. */
    state.gdt[1] |= accessed;
    state.gdt[2] |= accessed;
    state.gdt[3] |= accessed;
    state.gdt[4] |= accessed;
    CHECK(swyp_x86_privilege_validate(&state) == SWYP_OK);
    CHECK(swyp_x86_trap_install_exception_idt(&state, 1u) == SWYP_OK);
    state.gdt[2] ^= UINT64_C(1) << 41; /* writable -> read-only data is a real change */
    CHECK(swyp_x86_privilege_validate(&state) == SWYP_ERR_CORRUPT);
    state.gdt[2] ^= UINT64_C(1) << 41;
    CHECK(swyp_x86_privilege_validate(&state) == SWYP_OK);
    state.gdt[5] = (state.gdt[5] & ~access_mask) | (UINT64_C(0x82) << 40); /* LDT, not a TSS */
    CHECK(swyp_x86_privilege_validate(&state) == SWYP_ERR_CORRUPT);
    state.gdt[5] = (state.gdt[5] & ~access_mask) | (UINT64_C(0x0b) << 40); /* busy TSS, not present */
    CHECK(swyp_x86_privilege_validate(&state) == SWYP_ERR_CORRUPT);
}

static SwypStatus test_trap_handler_ok(void *context, SwypX86TrapFrame *frame) {
    uint64_t *count = (uint64_t *)context;
    if (count == NULL || frame == NULL) {
        return SWYP_ERR_INVALID;
    }
    *count += 1u;
    return SWYP_OK;
}

static void test_x86_trap_abi(void) {
    SwypX86PrivilegeState privilege;
    SwypX86TrapDispatchTable table;
    struct {
        SwypX86TrapFrame frame;
        uint64_t user_rsp;
        uint64_t user_ss;
    } user_frame = {0};
    SwypX86TrapFrame kernel_frame = {0};
    uint64_t handled = 0u;
    SwypX86FatalTrapRecord fatal = {0};
    uint32_t vector;

    CHECK(swyp_x86_privilege_init(&privilege, UINT64_C(0xffff800000100000)) == SWYP_OK);
    CHECK(swyp_x86_privilege_set_ist(&privilege, 1u, UINT64_C(0xffff800000110000)) == SWYP_OK);
    CHECK(swyp_x86_trap_install_exception_idt(&privilege, 1u) == SWYP_OK);
    for (vector = 0u; vector < SWYP_X86_EXCEPTION_COUNT; ++vector) {
        CHECK(swyp_x86_privilege_idt_handler(&privilege, vector) == swyp_x86_exception_stub_table[vector]);
        CHECK((privilege.idt[vector].type_attributes & UINT8_C(0x80)) != 0u);
    }
    CHECK(privilege.idt[2].ist == 1u && privilege.idt[8].ist == 1u && privilege.idt[18].ist == 1u);
    CHECK(privilege.idt[14].ist == 0u);
    CHECK(privilege.idt[3].type_attributes == UINT8_C(0xef));
    CHECK(privilege.idt[4].type_attributes == UINT8_C(0xef));
    CHECK(privilege.idt[14].type_attributes == UINT8_C(0x8e));

    for (vector = 0u; vector < SWYP_X86_EXCEPTION_COUNT; ++vector) {
        int expected = vector == 8u || vector == 10u || vector == 11u || vector == 12u || vector == 13u ||
                       vector == 14u || vector == 17u || vector == 21u || vector == 29u || vector == 30u;
        CHECK(swyp_x86_trap_vector_has_error_code(vector) == expected);
    }
    CHECK(swyp_x86_trap_vector_has_error_code(32u) == 0);

    kernel_frame.cs = SWYP_X86_SELECTOR_KERNEL_CODE;
    CHECK(!swyp_x86_trap_from_user(&kernel_frame));
    CHECK(swyp_x86_trap_user_rsp(&kernel_frame) == 0u && swyp_x86_trap_user_ss(&kernel_frame) == 0u);
    user_frame.frame.cs = SWYP_X86_SELECTOR_USER_CODE;
    user_frame.user_rsp = UINT64_C(0x00007fffffffe000);
    user_frame.user_ss = SWYP_X86_SELECTOR_USER_DATA;
    CHECK(swyp_x86_trap_from_user(&user_frame.frame));
    CHECK(swyp_x86_trap_user_rsp(&user_frame.frame) == user_frame.user_rsp);
    CHECK(swyp_x86_trap_user_ss(&user_frame.frame) == user_frame.user_ss);

    swyp_x86_trap_table_init(&table, &handled);
    CHECK(swyp_x86_trap_set_handler(&table, 14u, test_trap_handler_ok) == SWYP_OK);
    CHECK(swyp_x86_trap_set_handler(&table, 32u, test_trap_handler_ok) == SWYP_ERR_INVALID);
    CHECK(swyp_x86_trap_bind_dispatch_table(&table) == SWYP_OK);
    user_frame.frame.vector = 14u;
    CHECK(table.handlers[14](table.context, &user_frame.frame) == SWYP_OK && handled == 1u);

    user_frame.frame.error_code = UINT64_C(0x5);
    user_frame.frame.rip = UINT64_C(0x0000000000401000);
    user_frame.frame.rflags = UINT64_C(0x202);
    CHECK(swyp_x86_trap_record_fatal(&fatal, &user_frame.frame) == SWYP_ERR_CORRUPT);
    CHECK(fatal.sequence == 1u && fatal.vector == 14u && fatal.error_code == UINT64_C(0x5) &&
          fatal.rip == user_frame.frame.rip && fatal.user_rsp == user_frame.user_rsp &&
          fatal.user_ss == user_frame.user_ss);
}

typedef struct FakeApicHardware {
    uint32_t ioapic_regs[256];
    uint32_t ioapic_reads;
    uint32_t ioapic_writes;
    uint32_t lapic_writes;
    uint32_t last_lapic_offset;
    uint32_t last_lapic_value;
    uint32_t fail_write_reg;
    uint32_t fail_write_once;
    uint64_t tsc;
    uint64_t tsc_deadline;
    uint32_t tsc_deadline_writes;
} FakeApicHardware;

static SwypStatus fake_apic_ioapic_read(void *context, uint32_t reg, uint32_t *value) {
    FakeApicHardware *hardware = (FakeApicHardware *)context;
    if (hardware == NULL || value == NULL || reg >= 256u) {
        return SWYP_ERR_INVALID;
    }
    hardware->ioapic_reads += 1u;
    *value = hardware->ioapic_regs[reg];
    return SWYP_OK;
}

static SwypStatus fake_apic_ioapic_write(void *context, uint32_t reg, uint32_t value) {
    FakeApicHardware *hardware = (FakeApicHardware *)context;
    if (hardware == NULL || reg >= 256u) {
        return SWYP_ERR_INVALID;
    }
    hardware->ioapic_writes += 1u;
    if (hardware->fail_write_once != 0u && hardware->fail_write_reg == reg) {
        hardware->fail_write_once = 0u;
        return SWYP_ERR_CORRUPT;
    }
    hardware->ioapic_regs[reg] = value;
    return SWYP_OK;
}

static SwypStatus fake_apic_lapic_write(void *context, uint32_t offset, uint32_t value) {
    FakeApicHardware *hardware = (FakeApicHardware *)context;
    if (hardware == NULL) {
        return SWYP_ERR_INVALID;
    }
    hardware->lapic_writes += 1u;
    hardware->last_lapic_offset = offset;
    hardware->last_lapic_value = value;
    return SWYP_OK;
}

static uint64_t fake_timer_read_tsc(void *context) {
    FakeApicHardware *hardware = (FakeApicHardware *)context;
    return hardware == NULL ? 0u : hardware->tsc;
}

static SwypStatus fake_timer_write_tsc_deadline(void *context, uint64_t deadline) {
    FakeApicHardware *hardware = (FakeApicHardware *)context;
    if (hardware == NULL) {
        return SWYP_ERR_INVALID;
    }
    hardware->tsc_deadline = deadline;
    hardware->tsc_deadline_writes += 1u;
    return SWYP_OK;
}

static const SwypX86ApicHardwareOps fake_apic_hardware_ops = {
    .ioapic_read = fake_apic_ioapic_read,
    .ioapic_write = fake_apic_ioapic_write,
    .lapic_write = fake_apic_lapic_write,
};

static const SwypX86LapicTimerHardwareOps fake_timer_hardware_ops = {
    .lapic_write = fake_apic_lapic_write,
    .read_tsc = fake_timer_read_tsc,
    .write_tsc_deadline = fake_timer_write_tsc_deadline,
};

typedef struct FakeExtendedStateHardware {
    SwypX86FxState hardware_fx;
    SwypX86FxState last_restored_fx;
    uint64_t fs_base;
    uint64_t gs_base;
    uint64_t last_written_fs;
    uint64_t last_written_gs;
    uint32_t saves;
    uint32_t restores;
} FakeExtendedStateHardware;

static SwypStatus fake_extended_save_fx(void *context, SwypX86FxState *state) {
    FakeExtendedStateHardware *hardware = (FakeExtendedStateHardware *)context;
    if (hardware == NULL || state == NULL) {
        return SWYP_ERR_INVALID;
    }
    *state = hardware->hardware_fx;
    hardware->saves += 1u;
    return SWYP_OK;
}

static SwypStatus fake_extended_restore_fx(void *context, const SwypX86FxState *state) {
    FakeExtendedStateHardware *hardware = (FakeExtendedStateHardware *)context;
    if (hardware == NULL || state == NULL) {
        return SWYP_ERR_INVALID;
    }
    hardware->last_restored_fx = *state;
    hardware->hardware_fx = *state;
    hardware->restores += 1u;
    return SWYP_OK;
}

static uint64_t fake_extended_read_fs(void *context) {
    FakeExtendedStateHardware *hardware = (FakeExtendedStateHardware *)context;
    return hardware == NULL ? 0u : hardware->fs_base;
}

static uint64_t fake_extended_read_gs(void *context) {
    FakeExtendedStateHardware *hardware = (FakeExtendedStateHardware *)context;
    return hardware == NULL ? 0u : hardware->gs_base;
}

static SwypStatus fake_extended_write_fs(void *context, uint64_t value) {
    FakeExtendedStateHardware *hardware = (FakeExtendedStateHardware *)context;
    if (hardware == NULL) {
        return SWYP_ERR_INVALID;
    }
    hardware->fs_base = value;
    hardware->last_written_fs = value;
    return SWYP_OK;
}

static SwypStatus fake_extended_write_gs(void *context, uint64_t value) {
    FakeExtendedStateHardware *hardware = (FakeExtendedStateHardware *)context;
    if (hardware == NULL) {
        return SWYP_ERR_INVALID;
    }
    hardware->gs_base = value;
    hardware->last_written_gs = value;
    return SWYP_OK;
}

static const SwypX86ExtendedStateOps fake_extended_state_ops = {
    .save_fx = fake_extended_save_fx,
    .restore_fx = fake_extended_restore_fx,
    .read_fs_base = fake_extended_read_fs,
    .read_gs_base = fake_extended_read_gs,
    .write_fs_base = fake_extended_write_fs,
    .write_gs_base = fake_extended_write_gs,
};

static SwypStatus fake_timer_tick_resume(void *context, SwypX86TrapFrame *frame, int *resume_user) {
    uint32_t *ticks = (uint32_t *)context;
    if (ticks == NULL || frame == NULL || resume_user == NULL) {
        return SWYP_ERR_INVALID;
    }
    *ticks += 1u;
    *resume_user = 1;
    return SWYP_OK;
}

static void test_x86_lapic_timer_modes(void) {
    FakeApicHardware hardware = {.tsc = UINT64_C(1000)};
    SwypX86LapicTimer timer;
    SwypX86TrapFrame frame = {0};
    uint32_t ticks = 0u;

    CHECK(swyp_x86_lapic_timer_init_tsc_deadline(&timer, &hardware, &fake_timer_hardware_ops, UINT64_C(100),
                                                 &ticks, fake_timer_tick_resume) == SWYP_OK);
    CHECK(swyp_x86_lapic_timer_bind(&timer) == SWYP_OK);
    CHECK(swyp_x86_lapic_timer_arm_periodic(&timer) == SWYP_OK);
    CHECK(timer.armed != 0u && hardware.tsc_deadline == UINT64_C(1100) && hardware.tsc_deadline_writes == 1u);
    frame.vector = SWYP_X86_TIMER_VECTOR;
    frame.error_code = 0u;
    hardware.tsc = UINT64_C(1200);
    swyp_x86_lapic_timer_dispatch(&frame);
    CHECK(ticks == 1u);
    CHECK(hardware.last_lapic_offset == 0xB0u && hardware.last_lapic_value == 0u);
    CHECK(hardware.tsc_deadline == UINT64_C(1300) && hardware.tsc_deadline_writes == 2u);
    CHECK(swyp_x86_lapic_timer_disarm(&timer) == SWYP_OK);
    CHECK(timer.armed == 0u && hardware.tsc_deadline == 0u && hardware.tsc_deadline_writes == 3u);

    memset(&hardware, 0, sizeof(hardware));
    CHECK(swyp_x86_lapic_timer_init(&timer, &hardware, &fake_timer_hardware_ops, 500u, 3u, &ticks,
                                    fake_timer_tick_resume) == SWYP_OK);
    CHECK(swyp_x86_lapic_timer_arm_periodic(&timer) == SWYP_OK);
    CHECK(timer.armed != 0u && hardware.lapic_writes == 4u && hardware.last_lapic_offset == 0x320u);
    CHECK(swyp_x86_lapic_timer_disarm(&timer) == SWYP_OK && timer.armed == 0u);
}

static void test_x86_apic(void) {
    FakeApicHardware hardware = {0};
    SwypX86Apic apic;
    SwypInterruptSource *interrupts;
    uint32_t low_reg = 0x10u + 17u * 2u;
    uint32_t high_reg = low_reg + 1u;
    uint32_t preserved = (1u << 13) | (1u << 15);

    hardware.ioapic_regs[low_reg] = preserved | 45u;
    hardware.ioapic_regs[high_reg] = UINT32_C(1) << 24;
    CHECK(swyp_x86_apic_init(&apic, &hardware, &fake_apic_hardware_ops, 0u, 24u, 2u) == SWYP_OK);
    interrupts = swyp_x86_apic_contract(&apic);
    CHECK(interrupts != NULL && interrupts->ops != NULL);
    CHECK(interrupts->ops->bind(interrupts->context, 17u, 31u) == SWYP_ERR_INVALID);
    CHECK(interrupts->ops->bind(interrupts->context, 30u, 80u) == SWYP_ERR_NOT_FOUND);
    CHECK(interrupts->ops->bind(interrupts->context, 17u, 80u) == SWYP_OK);
    CHECK(hardware.ioapic_regs[high_reg] == (UINT32_C(2) << 24));
    CHECK(hardware.ioapic_regs[low_reg] == (80u | preserved | (1u << 16)));
    CHECK(interrupts->ops->bind(interrupts->context, 17u, 81u) == SWYP_ERR_DENIED);
    CHECK(interrupts->ops->unmask(interrupts->context, 17u) == SWYP_OK);
    CHECK(hardware.ioapic_regs[low_reg] == (80u | preserved));
    CHECK(interrupts->ops->end_of_interrupt(interrupts->context, 17u) == SWYP_OK);
    CHECK(hardware.lapic_writes == 1u && hardware.last_lapic_offset == 0xB0u && hardware.last_lapic_value == 0u);
    CHECK(interrupts->ops->mask(interrupts->context, 17u) == SWYP_OK);
    CHECK((hardware.ioapic_regs[low_reg] & (1u << 16)) != 0u);
    CHECK(interrupts->ops->unbind(interrupts->context, 17u) == SWYP_OK);
    CHECK(hardware.ioapic_regs[high_reg] == 0u);
    CHECK(hardware.ioapic_regs[low_reg] == (preserved | (1u << 16)));
    CHECK(interrupts->ops->end_of_interrupt(interrupts->context, 17u) == SWYP_ERR_NOT_FOUND);

    hardware.ioapic_regs[low_reg] = preserved | 50u;
    hardware.ioapic_regs[high_reg] = UINT32_C(3) << 24;
    hardware.fail_write_reg = high_reg;
    hardware.fail_write_once = 1u;
    CHECK(interrupts->ops->bind(interrupts->context, 17u, 82u) == SWYP_ERR_CORRUPT);
    CHECK(hardware.ioapic_regs[low_reg] == (preserved | 50u));
    CHECK(apic.routes[17].bound == 0u && apic.failed == 0u);
}

typedef struct FakeIommuHardware {
    uint32_t maps;
    uint32_t unmaps;
    uint32_t invalidates;
    uint32_t fail_invalidate_once;
    uint64_t last_domain;
    uint64_t last_device;
    uint64_t last_iova;
    uint64_t last_physical;
    uint64_t last_pages;
    uint64_t last_rights;
} FakeIommuHardware;

static SwypStatus fake_iommu_map_pages(void *context, uint64_t domain_id, uint64_t device_id, uint64_t iova,
                                       uint64_t physical_address, uint64_t page_count, uint64_t access_rights) {
    FakeIommuHardware *hardware = (FakeIommuHardware *)context;
    if (hardware == NULL || domain_id == 0u || device_id == 0u || page_count == 0u) {
        return SWYP_ERR_INVALID;
    }
    hardware->maps += 1u;
    hardware->last_domain = domain_id;
    hardware->last_device = device_id;
    hardware->last_iova = iova;
    hardware->last_physical = physical_address;
    hardware->last_pages = page_count;
    hardware->last_rights = access_rights;
    return SWYP_OK;
}

static SwypStatus fake_iommu_unmap_pages(void *context, uint64_t domain_id, uint64_t device_id, uint64_t iova,
                                         uint64_t page_count) {
    FakeIommuHardware *hardware = (FakeIommuHardware *)context;
    if (hardware == NULL || domain_id == 0u || device_id == 0u || page_count == 0u) {
        return SWYP_ERR_INVALID;
    }
    hardware->unmaps += 1u;
    hardware->last_domain = domain_id;
    hardware->last_device = device_id;
    hardware->last_iova = iova;
    hardware->last_pages = page_count;
    return SWYP_OK;
}

static SwypStatus fake_iommu_invalidate_domain(void *context, uint64_t domain_id) {
    FakeIommuHardware *hardware = (FakeIommuHardware *)context;
    if (hardware == NULL || domain_id == 0u) {
        return SWYP_ERR_INVALID;
    }
    hardware->invalidates += 1u;
    hardware->last_domain = domain_id;
    if (hardware->fail_invalidate_once != 0u) {
        hardware->fail_invalidate_once = 0u;
        return SWYP_ERR_CORRUPT;
    }
    return SWYP_OK;
}

static const SwypX86IommuHardwareOps fake_iommu_hardware_ops = {
    .map_pages = fake_iommu_map_pages,
    .unmap_pages = fake_iommu_unmap_pages,
    .invalidate_domain = fake_iommu_invalidate_domain,
};

static void test_x86_iommu(void) {
    FakeIommuHardware hardware = {0};
    SwypX86Iommu iommu;
    SwypCapabilityObject dma = {
        .type = SWYP_CAP_OBJECT_DMA,
        .object_id = 2u,
        .base = UINT64_C(0x20000000),
        .length = UINT64_C(0x4000),
    };
    SwypCapabilityObject memory = {
        .type = SWYP_CAP_OBJECT_SHARED_MEMORY,
        .object_id = 2u,
        .base = UINT64_C(0x30000000),
        .length = UINT64_C(0x8000),
    };
    uint64_t token1 = 0u;
    uint64_t token2 = 0u;
    uint64_t iova1 = 0u;
    uint64_t iova2 = 0u;

    swyp_x86_iommu_init(&iommu, &hardware, &fake_iommu_hardware_ops);
    CHECK(swyp_x86_iommu_map(&iommu, &dma, &memory, UINT64_C(0x30001000), 700u, 11u, UINT64_C(0x2000),
                             SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE, &token1, &iova1) == SWYP_OK);
    CHECK(token1 != 0u && iova1 == dma.base);
    CHECK(hardware.maps == 1u && hardware.invalidates == 1u && hardware.last_physical == UINT64_C(0x30001000));
    CHECK(hardware.last_pages == 2u && hardware.last_rights == (SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE));
    CHECK(swyp_x86_iommu_map(&iommu, &dma, &memory, UINT64_C(0x30004000), 700u, 11u, UINT64_C(0x1000),
                             SWYP_CAP_RIGHT_READ, &token2, &iova2) == SWYP_OK);
    CHECK(iova2 == dma.base + UINT64_C(0x2000));
    CHECK(swyp_x86_iommu_map(&iommu, &dma, &memory, UINT64_C(0x30005000), 700u, 11u, UINT64_C(0x2000),
                             SWYP_CAP_RIGHT_READ, &iova1, &iova2) == SWYP_ERR_NO_SPACE);
    CHECK(swyp_x86_iommu_map(&iommu, &dma, &memory, UINT64_C(0x30000001), 700u, 11u, UINT64_C(0x1000),
                             SWYP_CAP_RIGHT_READ, &iova1, &iova2) == SWYP_ERR_INVALID);
    CHECK(swyp_x86_iommu_domain_has_mappings(&iommu, 700u, 11u));
    CHECK(swyp_x86_iommu_unmap(&iommu, token1) == SWYP_OK);
    CHECK(hardware.unmaps == 1u);

    hardware.fail_invalidate_once = 1u;
    CHECK(swyp_x86_iommu_unmap(&iommu, token2) == SWYP_ERR_CORRUPT);
    CHECK(hardware.unmaps == 2u);
    CHECK(swyp_x86_iommu_domain_has_mappings(&iommu, 700u, 11u));
    CHECK(swyp_x86_iommu_unmap(&iommu, token2) == SWYP_OK);
    CHECK(hardware.unmaps == 2u);
    CHECK(!swyp_x86_iommu_domain_has_mappings(&iommu, 700u, 11u));
    CHECK(swyp_x86_iommu_unmap(&iommu, token2) == SWYP_ERR_STALE);

    hardware.fail_invalidate_once = 1u;
    CHECK(swyp_x86_iommu_map(&iommu, &dma, &memory, UINT64_C(0x30000000), 701u, 1u, UINT64_C(0x1000),
                             SWYP_CAP_RIGHT_READ, &token1, &iova1) == SWYP_ERR_CORRUPT);
    CHECK(hardware.maps == 3u && hardware.unmaps == 3u && iommu.failed == 0u);
    CHECK(!swyp_x86_iommu_domain_has_mappings(&iommu, 701u, 1u));
}

#define TEST_VTD_REG_CAP 0x08u
#define TEST_VTD_REG_ECAP 0x10u
#define TEST_VTD_REG_GCMD 0x18u
#define TEST_VTD_REG_GSTS 0x1cu
#define TEST_VTD_REG_RTADDR 0x20u
#define TEST_VTD_REG_CCMD 0x28u
#define TEST_VTD_IRO UINT64_C(0x20)
#define TEST_VTD_IOTLB_OFFSET 0x208u
#define TEST_VTD_GCMD_TE (UINT32_C(1) << 31)
#define TEST_VTD_GCMD_SRTP (UINT32_C(1) << 30)
#define TEST_VTD_CCMD_ICC (UINT64_C(1) << 63)
#define TEST_VTD_IOTLB_IVT (UINT64_C(1) << 63)

typedef struct FakeVtdRegisters {
    uint64_t capability;
    uint64_t extended_capability;
    uint64_t root_address;
    uint64_t ccmd;
    uint64_t iotlb;
    uint32_t gcmd;
    uint32_t gsts;
    uint32_t root_programs;
    uint32_t translation_enables;
    uint32_t context_invalidates;
    uint32_t iotlb_invalidates;
    uint32_t fail_iotlb_once;
} FakeVtdRegisters;

static SwypStatus fake_vtd_read32(void *context, uint32_t offset, uint32_t *value) {
    FakeVtdRegisters *registers = (FakeVtdRegisters *)context;
    if (registers == NULL || value == NULL) {
        return SWYP_ERR_INVALID;
    }
    if (offset == TEST_VTD_REG_GCMD) {
        *value = registers->gcmd;
        return SWYP_OK;
    }
    if (offset == TEST_VTD_REG_GSTS) {
        *value = registers->gsts;
        return SWYP_OK;
    }
    return SWYP_ERR_NOT_FOUND;
}

static SwypStatus fake_vtd_write32(void *context, uint32_t offset, uint32_t value) {
    FakeVtdRegisters *registers = (FakeVtdRegisters *)context;
    if (registers == NULL || offset != TEST_VTD_REG_GCMD) {
        return SWYP_ERR_INVALID;
    }
    registers->gcmd = value;
    if ((value & TEST_VTD_GCMD_SRTP) != 0u) {
        registers->gsts |= TEST_VTD_GCMD_SRTP;
        registers->root_programs += 1u;
    }
    if ((value & TEST_VTD_GCMD_TE) != 0u) {
        registers->gsts |= TEST_VTD_GCMD_TE;
        registers->translation_enables += 1u;
    } else {
        registers->gsts &= ~TEST_VTD_GCMD_TE;
    }
    return SWYP_OK;
}

static SwypStatus fake_vtd_read64(void *context, uint32_t offset, uint64_t *value) {
    FakeVtdRegisters *registers = (FakeVtdRegisters *)context;
    if (registers == NULL || value == NULL) {
        return SWYP_ERR_INVALID;
    }
    switch (offset) {
    case TEST_VTD_REG_CAP:
        *value = registers->capability;
        return SWYP_OK;
    case TEST_VTD_REG_ECAP:
        *value = registers->extended_capability;
        return SWYP_OK;
    case TEST_VTD_REG_RTADDR:
        *value = registers->root_address;
        return SWYP_OK;
    case TEST_VTD_REG_CCMD:
        *value = registers->ccmd;
        return SWYP_OK;
    case TEST_VTD_IOTLB_OFFSET:
        *value = registers->iotlb;
        return SWYP_OK;
    default:
        return SWYP_ERR_NOT_FOUND;
    }
}

static SwypStatus fake_vtd_write64(void *context, uint32_t offset, uint64_t value) {
    FakeVtdRegisters *registers = (FakeVtdRegisters *)context;
    if (registers == NULL) {
        return SWYP_ERR_INVALID;
    }
    if (offset == TEST_VTD_REG_RTADDR) {
        registers->root_address = value;
        return SWYP_OK;
    }
    if (offset == TEST_VTD_REG_CCMD) {
        registers->context_invalidates += 1u;
        registers->ccmd = value & ~TEST_VTD_CCMD_ICC;
        return SWYP_OK;
    }
    if (offset == TEST_VTD_IOTLB_OFFSET) {
        uint64_t requested = (value >> 60) & UINT64_C(0x3);
        uint64_t actual = requested == 1u ? 1u : 2u;
        registers->iotlb_invalidates += 1u;
        if (registers->fail_iotlb_once != 0u) {
            registers->fail_iotlb_once = 0u;
            return SWYP_ERR_CORRUPT;
        }
        registers->iotlb = (value & ~TEST_VTD_IOTLB_IVT & ~(UINT64_C(0x3) << 57)) | (actual << 57);
        return SWYP_OK;
    }
    return SWYP_ERR_NOT_FOUND;
}

static const SwypX86VtdRegisterOps fake_vtd_register_ops = {
    .read32 = fake_vtd_read32,
    .write32 = fake_vtd_write32,
    .read64 = fake_vtd_read64,
    .write64 = fake_vtd_write64,
};

static SwypX86VtdDomain *test_vtd_domain(SwypX86Vtd *vtd, uint64_t domain_id) {
    uint32_t i;
    for (i = 0u; i < SWYP_X86_VTD_DOMAIN_CAPACITY; ++i) {
        if (vtd->domains[i].active != 0u && vtd->domains[i].domain_id == domain_id) {
            return &vtd->domains[i];
        }
    }
    return NULL;
}

static void test_x86_vtd_legacy_backend(void) {
    FakeX86PagePool pool = {0};
    FakeX86Hardware memory = {.pool = &pool};
    SwypPageAllocator allocator = {.context = &pool, .ops = &fake_x86_allocator_ops};
    FakeVtdRegisters registers = {
        .capability = (UINT64_C(1) << 10) | UINT64_C(1),
        .extended_capability = UINT64_C(1) | (TEST_VTD_IRO << 8),
    };
    SwypX86Vtd vtd;
    SwypX86Iommu iommu;
    SwypCapabilityObject dma = {
        .type = SWYP_CAP_OBJECT_DMA,
        .object_id = 2u,
        .base = UINT64_C(0x20000000),
        .length = UINT64_C(0x4000),
    };
    SwypCapabilityObject shared = {
        .type = SWYP_CAP_OBJECT_SHARED_MEMORY,
        .object_id = 2u,
        .base = UINT64_C(0x30000000),
        .length = UINT64_C(0x8000),
    };
    uint64_t requester = swyp_x86_pci_config_aux(0u, 2u, 3u, 1u);
    uint64_t token = 0u;
    uint64_t iova = 0u;
    uint64_t physical = 0u;
    uint64_t rights = 0u;
    SwypX86VtdDomain *domain;
    uint64_t *root_words;
    uint64_t *context_words;
    uint64_t context_physical;
    uint8_t devfn = (uint8_t)((3u << 3) | 1u);

    CHECK(swyp_x86_vtd_init(&vtd, 0u, &allocator, &memory, &fake_x86_hardware_ops, &registers,
                            &fake_vtd_register_ops) == SWYP_OK);
    CHECK(swyp_x86_vtd_is_enabled(&vtd));
    CHECK(registers.root_programs == 1u && registers.translation_enables == 1u);
    CHECK(registers.root_address == vtd.root_table_physical);
    CHECK(fake_x86_used_pages(&pool) == 1u);

    swyp_x86_iommu_init(&iommu, &vtd, swyp_x86_vtd_iommu_ops());
    CHECK(swyp_x86_iommu_map(&iommu, &dma, &shared, UINT64_C(0x30001000), 700u, 11u,
                             UINT64_C(0x1000), SWYP_CAP_RIGHT_READ, &token, &iova) == SWYP_ERR_DENIED);
    CHECK(swyp_x86_iommu_attach_device(&iommu, 700u, 11u, 2u, requester) == SWYP_OK);
    CHECK(swyp_x86_iommu_domain_has_devices(&iommu, 700u, 11u));
    domain = test_vtd_domain(&vtd, 700u);
    CHECK(domain != NULL && domain->hardware_did != 0u && domain->device_count == 1u);
    {
        uint32_t pages_before_duplicate = fake_x86_used_pages(&pool);
        CHECK(swyp_x86_iommu_attach_device(&iommu, 702u, 13u, 99u, requester) == SWYP_ERR_DENIED);
        CHECK(!swyp_x86_iommu_domain_has_devices(&iommu, 702u, 13u));
        CHECK(test_vtd_domain(&vtd, 702u) == NULL);
        CHECK(fake_x86_used_pages(&pool) == pages_before_duplicate);
    }
    CHECK(vtd.context_tables[2] != 0u);
    root_words = (uint64_t *)fake_x86_physical_to_virtual(&memory, vtd.root_table_physical);
    context_physical = root_words[2u * 2u] & UINT64_C(0x000ffffffffff000);
    CHECK((root_words[2u * 2u] & 1u) != 0u && context_physical == vtd.context_tables[2]);
    context_words = (uint64_t *)fake_x86_physical_to_virtual(&memory, context_physical);
    CHECK((context_words[(uint32_t)devfn * 2u] & 1u) != 0u);
    CHECK((context_words[(uint32_t)devfn * 2u] & UINT64_C(0x000ffffffffff000)) == domain->sl_root_physical);
    CHECK((context_words[(uint32_t)devfn * 2u + 1u] & UINT64_C(0x7)) == UINT64_C(2));
    CHECK(((context_words[(uint32_t)devfn * 2u + 1u] >> 8) & UINT64_C(0xffff)) == domain->hardware_did);

    CHECK(swyp_x86_iommu_map(&iommu, &dma, &shared, UINT64_C(0x30001000), 700u, 11u, UINT64_C(0x2000),
                             SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE, &token, &iova) == SWYP_OK);
    CHECK(iova == dma.base);
    CHECK(swyp_x86_vtd_query(&vtd, 700u, iova + UINT64_C(0x123), &physical, &rights) == SWYP_OK);
    CHECK(physical == UINT64_C(0x30001123));
    CHECK(rights == (SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE));
    CHECK(swyp_x86_iommu_detach_device(&iommu, 700u, 11u, 2u) == SWYP_ERR_DENIED);
    CHECK(swyp_x86_iommu_unmap(&iommu, token) == SWYP_OK);
    CHECK(swyp_x86_vtd_query(&vtd, 700u, iova, &physical, &rights) == SWYP_ERR_NOT_FOUND);
    CHECK(swyp_x86_iommu_detach_device(&iommu, 700u, 11u, 2u) == SWYP_OK);
    CHECK(!swyp_x86_iommu_domain_has_devices(&iommu, 700u, 11u));
    CHECK(test_vtd_domain(&vtd, 700u) == NULL);
    CHECK(fake_x86_used_pages(&pool) == 2u); /* persistent VT-d root + bus-2 context table */

    CHECK(swyp_x86_iommu_attach_device(&iommu, 701u, 12u, 3u, swyp_x86_pci_config_aux(0u, 2u, 4u, 0u)) ==
          SWYP_OK);
    registers.fail_iotlb_once = 1u;
    CHECK(swyp_x86_iommu_map(&iommu, &((SwypCapabilityObject){
                                     .type = SWYP_CAP_OBJECT_DMA,
                                     .object_id = 3u,
                                     .base = UINT64_C(0x21000000),
                                     .length = UINT64_C(0x2000)}),
                             &shared, UINT64_C(0x30002000), 701u, 12u, UINT64_C(0x1000), SWYP_CAP_RIGHT_READ,
                             &token, &iova) == SWYP_ERR_CORRUPT);
    CHECK(!swyp_x86_iommu_domain_has_mappings(&iommu, 701u, 12u));
    CHECK(swyp_x86_vtd_query(&vtd, 701u, UINT64_C(0x21000000), &physical, &rights) == SWYP_ERR_NOT_FOUND);
    CHECK(iommu.failed == 0u && vtd.failed == 0u);
    CHECK(swyp_x86_iommu_detach_device(&iommu, 701u, 12u, 3u) == SWYP_OK);
    CHECK(swyp_x86_vtd_shutdown(&vtd) == SWYP_OK);
    CHECK(fake_x86_used_pages(&pool) == 0u);
}

static int test_vtd_has_device(const SwypX86Vtd *vtd, uint64_t domain_id, uint64_t device_id) {
    uint32_t i;
    if (vtd == NULL) {
        return 0;
    }
    for (i = 0u; i < SWYP_X86_VTD_DEVICE_CAPACITY; ++i) {
        if (vtd->devices[i].active != 0u && vtd->devices[i].domain_id == domain_id &&
            vtd->devices[i].device_id == device_id) {
            return 1;
        }
    }
    return 0;
}

static void test_x86_vtd_router_multi_drhd(void) {
    FakeX86PagePool pool = {0};
    FakeX86Hardware memory = {.pool = &pool};
    SwypPageAllocator allocator = {.context = &pool, .ops = &fake_x86_allocator_ops};
    FakeVtdRegisters registers0 = {
        .capability = (UINT64_C(1) << 10) | UINT64_C(1),
        .extended_capability = UINT64_C(1) | (TEST_VTD_IRO << 8),
    };
    FakeVtdRegisters registers1 = {
        .capability = (UINT64_C(1) << 10) | UINT64_C(1),
        .extended_capability = UINT64_C(1) | (TEST_VTD_IRO << 8),
    };
    SwypX86Vtd vtd0;
    SwypX86Vtd vtd1;
    SwypX86Vtd *units[2] = {&vtd0, &vtd1};
    SwypX86VtdRouter router;
    SwypX86Iommu iommu;
    SwypAcpiPlatform acpi = {0};
    SwypCapabilityObject dma_scoped = {
        .type = SWYP_CAP_OBJECT_DMA,
        .object_id = 10u,
        .base = UINT64_C(0x22000000),
        .length = UINT64_C(0x4000),
    };
    SwypCapabilityObject dma_fallback = {
        .type = SWYP_CAP_OBJECT_DMA,
        .object_id = 11u,
        .base = UINT64_C(0x23000000),
        .length = UINT64_C(0x4000),
    };
    SwypCapabilityObject shared = {
        .type = SWYP_CAP_OBJECT_SHARED_MEMORY,
        .object_id = 10u,
        .base = UINT64_C(0x30000000),
        .length = UINT64_C(0x10000),
    };
    uint64_t token0 = 0u;
    uint64_t token1 = 0u;
    uint64_t iova0 = 0u;
    uint64_t iova1 = 0u;
    uint64_t physical = 0u;
    uint64_t rights = 0u;
    uint64_t requester_scoped = swyp_x86_pci_config_aux(0u, 2u, 3u, 1u);
    uint64_t requester_fallback = swyp_x86_pci_config_aux(0u, 4u, 1u, 0u);
    uint64_t requester_rmrr = swyp_x86_pci_config_aux(0u, 5u, 2u, 0u);

    acpi.dmar_unit_count = 2u;
    acpi.dmar_units[0].segment = 0u;
    acpi.dmar_units[0].flags = 1u;
    acpi.dmar_units[1].segment = 0u;
    acpi.dmar_units[1].first_scope = 0u;
    acpi.dmar_units[1].scope_count = 1u;
    acpi.dmar_reserved_count = 1u;
    acpi.dmar_reserved[0].segment = 0u;
    acpi.dmar_reserved[0].base = UINT64_C(0x9f000);
    acpi.dmar_reserved[0].limit = UINT64_C(0x9ffff);
    acpi.dmar_reserved[0].first_scope = 1u;
    acpi.dmar_reserved[0].scope_count = 1u;
    acpi.dmar_scope_count = 2u;
    acpi.dmar_scopes[0].type = 1u;
    acpi.dmar_scopes[0].segment = 0u;
    acpi.dmar_scopes[0].start_bus = 2u;
    acpi.dmar_scopes[0].path_count = 1u;
    acpi.dmar_scopes[0].path[0].device = 3u;
    acpi.dmar_scopes[0].path[0].function = 1u;
    acpi.dmar_scopes[1].type = 1u;
    acpi.dmar_scopes[1].segment = 0u;
    acpi.dmar_scopes[1].start_bus = 5u;
    acpi.dmar_scopes[1].path_count = 1u;
    acpi.dmar_scopes[1].path[0].device = 2u;
    acpi.dmar_scopes[1].path[0].function = 0u;

    CHECK(swyp_x86_vtd_init(&vtd0, 0u, &allocator, &memory, &fake_x86_hardware_ops, &registers0,
                            &fake_vtd_register_ops) == SWYP_OK);
    CHECK(swyp_x86_vtd_init(&vtd1, 0u, &allocator, &memory, &fake_x86_hardware_ops, &registers1,
                            &fake_vtd_register_ops) == SWYP_OK);
    CHECK(swyp_x86_vtd_router_init(&router, &acpi, units, 2u) == SWYP_OK);
    swyp_x86_iommu_init(&iommu, &router, swyp_x86_vtd_router_iommu_ops());

    CHECK(swyp_x86_iommu_attach_device(&iommu, 700u, 11u, 10u, requester_scoped) == SWYP_OK);
    CHECK(!test_vtd_has_device(&vtd0, 700u, 10u));
    CHECK(test_vtd_has_device(&vtd1, 700u, 10u));
    CHECK(swyp_x86_iommu_attach_device(&iommu, 700u, 11u, 11u, requester_fallback) == SWYP_OK);
    CHECK(test_vtd_has_device(&vtd0, 700u, 11u));
    CHECK(!test_vtd_has_device(&vtd1, 700u, 11u));
    CHECK(swyp_x86_iommu_attach_device(&iommu, 701u, 12u, 12u, requester_rmrr) == SWYP_ERR_DENIED);

    CHECK(swyp_x86_iommu_map(&iommu, &dma_scoped, &shared, UINT64_C(0x30000000), 700u, 11u,
                             SWYP_X86_IOMMU_PAGE_SIZE, SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE,
                             &token0, &iova0) == SWYP_OK);
    CHECK(swyp_x86_vtd_query(&vtd1, 700u, iova0, &physical, &rights) == SWYP_OK);
    CHECK(physical == UINT64_C(0x30000000));
    CHECK(swyp_x86_vtd_query(&vtd0, 700u, iova0, &physical, &rights) == SWYP_ERR_NOT_FOUND);

    shared.object_id = 11u;
    CHECK(swyp_x86_iommu_map(&iommu, &dma_fallback, &shared, UINT64_C(0x30002000), 700u, 11u,
                             SWYP_X86_IOMMU_PAGE_SIZE, SWYP_CAP_RIGHT_READ, &token1, &iova1) == SWYP_OK);
    CHECK(swyp_x86_vtd_query(&vtd0, 700u, iova1, &physical, &rights) == SWYP_OK);
    CHECK(physical == UINT64_C(0x30002000));
    CHECK(swyp_x86_vtd_query(&vtd1, 700u, iova1, &physical, &rights) == SWYP_ERR_NOT_FOUND);

    CHECK(swyp_x86_iommu_unmap(&iommu, token0) == SWYP_OK);
    CHECK(swyp_x86_iommu_unmap(&iommu, token1) == SWYP_OK);
    CHECK(swyp_x86_iommu_detach_device(&iommu, 700u, 11u, 10u) == SWYP_OK);
    CHECK(swyp_x86_iommu_detach_device(&iommu, 700u, 11u, 11u) == SWYP_OK);
    CHECK(swyp_x86_vtd_shutdown(&vtd1) == SWYP_OK);
    CHECK(swyp_x86_vtd_shutdown(&vtd0) == SWYP_OK);
    CHECK(fake_x86_used_pages(&pool) == 0u);
}

typedef struct FakePciHardware {
    uint32_t reads;
    uint32_t writes;
    uint64_t last_read_address;
    uint64_t last_write_address;
    uint32_t read_value;
    uint32_t last_write_value;
} FakePciHardware;

static SwypStatus fake_pci_read32(void *context, uint64_t physical_address, uint32_t *value) {
    FakePciHardware *hardware = (FakePciHardware *)context;
    if (hardware == NULL || value == NULL || (physical_address & UINT64_C(3)) != 0u) {
        return SWYP_ERR_INVALID;
    }
    hardware->reads += 1u;
    hardware->last_read_address = physical_address;
    *value = hardware->read_value;
    return SWYP_OK;
}

static SwypStatus fake_pci_write32(void *context, uint64_t physical_address, uint32_t value) {
    FakePciHardware *hardware = (FakePciHardware *)context;
    if (hardware == NULL || (physical_address & UINT64_C(3)) != 0u) {
        return SWYP_ERR_INVALID;
    }
    hardware->writes += 1u;
    hardware->last_write_address = physical_address;
    hardware->last_write_value = value;
    return SWYP_OK;
}

static const SwypX86PciEcamHardwareOps fake_pci_hardware_ops = {
    .read32 = fake_pci_read32,
    .write32 = fake_pci_write32,
};

typedef struct FakePciTopology {
    uint64_t physical_base;
    uint32_t corrupt_first_bridge;
} FakePciTopology;

static SwypStatus fake_pci_topology_read32(void *context, uint64_t physical_address, uint32_t *value) {
    FakePciTopology *topology = (FakePciTopology *)context;
    uint64_t offset;
    uint8_t bus;
    uint8_t device;
    uint8_t function;
    uint16_t reg;
    if (topology == NULL || value == NULL || physical_address < topology->physical_base) {
        return SWYP_ERR_INVALID;
    }
    offset = physical_address - topology->physical_base;
    bus = (uint8_t)((offset >> 20) & UINT64_C(0xff));
    device = (uint8_t)((offset >> 15) & UINT64_C(0x1f));
    function = (uint8_t)((offset >> 12) & UINT64_C(0x7));
    reg = (uint16_t)(offset & UINT64_C(0xfff));
    if (bus == 0u && device == 1u && function == 0u) {
        if (reg == 0x08u) {
            *value = topology->corrupt_first_bridge != 0u ? UINT32_C(0x02000000) : UINT32_C(0x06040000);
            return SWYP_OK;
        }
        if (reg == 0x18u) {
            *value = UINT32_C(0x00040200); /* primary=0 secondary=2 subordinate=4 */
            return SWYP_OK;
        }
    }
    if (bus == 2u && device == 5u && function == 0u) {
        if (reg == 0x08u) {
            *value = UINT32_C(0x06040000);
            return SWYP_OK;
        }
        if (reg == 0x18u) {
            *value = UINT32_C(0x00040302); /* primary=2 secondary=3 subordinate=4 */
            return SWYP_OK;
        }
    }
    *value = UINT32_MAX;
    return SWYP_OK;
}

static SwypStatus fake_pci_topology_write32(void *context, uint64_t physical_address, uint32_t value) {
    (void)context;
    (void)physical_address;
    (void)value;
    return SWYP_ERR_UNSUPPORTED;
}

static const SwypX86PciEcamHardwareOps fake_pci_topology_ops = {
    .read32 = fake_pci_topology_read32,
    .write32 = fake_pci_topology_write32,
};

static void test_x86_pci_ecam(void) {
    FakePciHardware hardware = {.read_value = UINT32_C(0x11223344)};
    SwypX86PciEcam pci;
    SwypX86PciEcamSegment segment = {
        .segment = 0u,
        .start_bus = 0u,
        .end_bus = 255u,
        .physical_base = UINT64_C(0xe0000000),
    };
    SwypCapabilityObject config = {
        .type = SWYP_CAP_OBJECT_DEVICE_CONFIG,
        .object_id = 2u,
        .base = UINT64_C(0x40),
        .length = UINT64_C(0x40),
        .aux = 0u,
    };
    uint64_t value = 0u;
    uint64_t function_base = UINT64_C(0xe0000000) + (UINT64_C(2) << 20) + (UINT64_C(3) << 15) +
                             (UINT64_C(1) << 12);

    config.aux = swyp_x86_pci_config_aux(0u, 2u, 3u, 1u);
    CHECK(config.aux != UINT64_MAX);
    CHECK(swyp_x86_pci_ecam_init(&pci, &hardware, &fake_pci_hardware_ops, &segment, 1u) == SWYP_OK);
    CHECK(swyp_x86_pci_ecam_read(&pci, &config, 0x44u, 4u, &value) == SWYP_OK);
    CHECK(value == UINT64_C(0x11223344) && hardware.last_read_address == function_base + UINT64_C(0x44));
    CHECK(swyp_x86_pci_ecam_read(&pci, &config, 0x45u, 1u, &value) == SWYP_OK);
    CHECK(value == UINT64_C(0x33) && hardware.last_read_address == function_base + UINT64_C(0x44));
    CHECK(swyp_x86_pci_ecam_read(&pci, &config, 0x46u, 2u, &value) == SWYP_OK);
    CHECK(value == UINT64_C(0x1122));
    CHECK(swyp_x86_pci_ecam_read(&pci, &config, 0x45u, 2u, &value) == SWYP_ERR_INVALID);

    CHECK(swyp_x86_pci_ecam_write(&pci, &config, 0x48u, 4u, UINT64_C(0xdeadbeef)) == SWYP_OK);
    CHECK(hardware.last_write_address == function_base + UINT64_C(0x48) &&
          hardware.last_write_value == UINT32_C(0xdeadbeef));
    hardware.read_value = UINT32_C(0x11223344);
    CHECK(swyp_x86_pci_ecam_write(&pci, &config, 0x45u, 1u, UINT64_C(0xaa)) == SWYP_OK);
    CHECK(hardware.last_write_address == function_base + UINT64_C(0x44) &&
          hardware.last_write_value == UINT32_C(0x1122aa44));
    hardware.read_value = UINT32_C(0x11223344);
    CHECK(swyp_x86_pci_ecam_write(&pci, &config, 0x46u, 2u, UINT64_C(0xbeef)) == SWYP_OK);
    CHECK(hardware.last_write_value == UINT32_C(0xbeef3344));
    CHECK(swyp_x86_pci_ecam_write(&pci, &config, 0x40u, 1u, UINT64_C(0x100)) == SWYP_ERR_INVALID);

    config.aux = swyp_x86_pci_config_aux(1u, 2u, 3u, 1u);
    CHECK(swyp_x86_pci_ecam_read(&pci, &config, 0x40u, 4u, &value) == SWYP_ERR_NOT_FOUND);
    config.aux = UINT64_MAX;
    CHECK(swyp_x86_pci_ecam_read(&pci, &config, 0x40u, 4u, &value) == SWYP_ERR_INVALID);
    CHECK(swyp_x86_pci_config_aux(0u, 0u, 32u, 0u) == UINT64_MAX);
    CHECK(swyp_x86_pci_config_aux(0u, 0u, 0u, 8u) == UINT64_MAX);

    {
        SwypX86PciEcamSegment overlap[2] = {
            {.segment = 0u, .start_bus = 0u, .end_bus = 127u, .physical_base = UINT64_C(0xe0000000)},
            {.segment = 0u, .start_bus = 64u, .end_bus = 255u, .physical_base = UINT64_C(0xf0000000)},
        };
        CHECK(swyp_x86_pci_ecam_init(&pci, &hardware, &fake_pci_hardware_ops, overlap, 2u) == SWYP_ERR_INVALID);
    }
}

static void test_x86_vtd_router_pci_bridge_topology(void) {
    FakeX86PagePool pool = {0};
    FakeX86Hardware memory = {.pool = &pool};
    SwypPageAllocator allocator = {.context = &pool, .ops = &fake_x86_allocator_ops};
    FakeVtdRegisters registers0 = {
        .capability = (UINT64_C(1) << 10) | UINT64_C(1),
        .extended_capability = UINT64_C(1) | (TEST_VTD_IRO << 8),
    };
    FakeVtdRegisters registers1 = {
        .capability = (UINT64_C(1) << 10) | UINT64_C(1),
        .extended_capability = UINT64_C(1) | (TEST_VTD_IRO << 8),
    };
    SwypX86Vtd vtd0;
    SwypX86Vtd vtd1;
    SwypX86Vtd *units[2] = {&vtd0, &vtd1};
    SwypX86VtdRouter router;
    SwypX86Iommu iommu;
    SwypAcpiPlatform acpi = {0};
    SwypX86PciEcam pci;
    SwypX86PciEcamSegment segment = {
        .segment = 0u,
        .start_bus = 0u,
        .end_bus = 255u,
        .physical_base = UINT64_C(0xe0000000),
    };
    FakePciTopology topology = {.physical_base = UINT64_C(0xe0000000)};
    uint64_t endpoint_requester = swyp_x86_pci_config_aux(0u, 3u, 7u, 1u);
    uint64_t hierarchy_requester = swyp_x86_pci_config_aux(0u, 4u, 2u, 0u);
    uint64_t fallback_requester = swyp_x86_pci_config_aux(0u, 1u, 2u, 0u);
    uint64_t rmrr_base = 0u;
    uint64_t rmrr_limit = 0u;

    acpi.dmar_unit_count = 2u;
    acpi.dmar_units[0].segment = 0u;
    acpi.dmar_units[0].flags = 1u;
    acpi.dmar_units[1].segment = 0u;
    acpi.dmar_units[1].first_scope = 0u;
    acpi.dmar_units[1].scope_count = 2u;
    acpi.dmar_reserved_count = 1u;
    acpi.dmar_reserved[0].segment = 0u;
    acpi.dmar_reserved[0].base = UINT64_C(0x32000000);
    acpi.dmar_reserved[0].limit = UINT64_C(0x32001fff);
    acpi.dmar_reserved[0].first_scope = 2u;
    acpi.dmar_reserved[0].scope_count = 1u;
    acpi.dmar_scope_count = 3u;

    acpi.dmar_scopes[0].type = 1u;
    acpi.dmar_scopes[0].segment = 0u;
    acpi.dmar_scopes[0].start_bus = 0u;
    acpi.dmar_scopes[0].path_count = 3u;
    acpi.dmar_scopes[0].path[0] = (SwypAcpiDmarPathElement){1u, 0u};
    acpi.dmar_scopes[0].path[1] = (SwypAcpiDmarPathElement){5u, 0u};
    acpi.dmar_scopes[0].path[2] = (SwypAcpiDmarPathElement){7u, 1u};

    acpi.dmar_scopes[1].type = 2u;
    acpi.dmar_scopes[1].segment = 0u;
    acpi.dmar_scopes[1].start_bus = 0u;
    acpi.dmar_scopes[1].path_count = 1u;
    acpi.dmar_scopes[1].path[0] = (SwypAcpiDmarPathElement){1u, 0u};

    acpi.dmar_scopes[2] = acpi.dmar_scopes[0];

    CHECK(swyp_x86_pci_ecam_init(&pci, &topology, &fake_pci_topology_ops, &segment, 1u) == SWYP_OK);
    CHECK(swyp_x86_vtd_init(&vtd0, 0u, &allocator, &memory, &fake_x86_hardware_ops, &registers0,
                            &fake_vtd_register_ops) == SWYP_OK);
    CHECK(swyp_x86_vtd_init(&vtd1, 0u, &allocator, &memory, &fake_x86_hardware_ops, &registers1,
                            &fake_vtd_register_ops) == SWYP_OK);
    CHECK(swyp_x86_vtd_router_init(&router, &acpi, units, 2u) == SWYP_OK);
    swyp_x86_vtd_router_set_pci(&router, &pci);
    swyp_x86_iommu_init(&iommu, &router, swyp_x86_vtd_router_iommu_ops());

    CHECK(swyp_x86_vtd_router_reserved_for_requester(&router, endpoint_requester, &rmrr_base, &rmrr_limit) == SWYP_OK);
    CHECK(rmrr_base == UINT64_C(0x32000000) && rmrr_limit == UINT64_C(0x32001fff));
    CHECK(swyp_x86_iommu_attach_device(&iommu, 800u, 1u, 20u, endpoint_requester) == SWYP_ERR_DENIED);
    CHECK(swyp_x86_vtd_router_authorize_rmrr(&router, 800u, 20u, endpoint_requester, rmrr_base,
                                             rmrr_limit - rmrr_base + 1u) == SWYP_OK);
    CHECK(swyp_x86_iommu_attach_device(&iommu, 800u, 1u, 20u, endpoint_requester) == SWYP_OK);
    CHECK(test_vtd_has_device(&vtd1, 800u, 20u) && !test_vtd_has_device(&vtd0, 800u, 20u));

    CHECK(swyp_x86_iommu_attach_device(&iommu, 801u, 1u, 21u, hierarchy_requester) == SWYP_OK);
    CHECK(test_vtd_has_device(&vtd1, 801u, 21u) && !test_vtd_has_device(&vtd0, 801u, 21u));
    CHECK(swyp_x86_iommu_attach_device(&iommu, 802u, 1u, 22u, fallback_requester) == SWYP_OK);
    CHECK(test_vtd_has_device(&vtd0, 802u, 22u) && !test_vtd_has_device(&vtd1, 802u, 22u));

    topology.corrupt_first_bridge = 1u;
    CHECK(swyp_x86_iommu_attach_device(&iommu, 803u, 1u, 23u, swyp_x86_pci_config_aux(0u, 3u, 7u, 2u)) ==
          SWYP_ERR_CORRUPT);
    CHECK(!test_vtd_has_device(&vtd0, 803u, 23u) && !test_vtd_has_device(&vtd1, 803u, 23u));
    topology.corrupt_first_bridge = 0u;

    CHECK(swyp_x86_iommu_detach_device(&iommu, 800u, 1u, 20u) == SWYP_OK);
    CHECK(swyp_x86_iommu_detach_device(&iommu, 801u, 1u, 21u) == SWYP_OK);
    CHECK(swyp_x86_iommu_detach_device(&iommu, 802u, 1u, 22u) == SWYP_OK);
    CHECK(swyp_x86_vtd_shutdown(&vtd1) == SWYP_OK);
    CHECK(swyp_x86_vtd_shutdown(&vtd0) == SWYP_OK);
    CHECK(fake_x86_used_pages(&pool) == 0u);
}

static void test_capabilities(void) {
    SwypCapabilityTable table;
    SwypCapabilityObject object = {
        .type = SWYP_CAP_OBJECT_MMIO,
        .object_id = UINT64_C(0x42),
        .base = UINT64_C(0xfebf0000),
        .length = UINT64_C(0x1000),
        .aux = 0u,
    };
    SwypCapabilityHandle handle = 0u;
    SwypCapabilityHandle replacement = 0u;
    const SwypCapabilityGrant *grant = NULL;

    swyp_capability_table_init(&table);
    CHECK(swyp_capability_mint(&table, &object, SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_MAP, 7u, 11u, &handle) == SWYP_OK);
    CHECK(handle != 0u);
    CHECK(swyp_capability_lookup(&table, handle, 7u, 11u, SWYP_CAP_RIGHT_READ, &grant) == SWYP_OK);
    CHECK(grant != NULL && grant->object.base == object.base);
    CHECK(swyp_capability_lookup(&table, handle, 8u, 11u, SWYP_CAP_RIGHT_READ, &grant) == SWYP_ERR_DENIED);
    CHECK(swyp_capability_lookup(&table, handle, 7u, 12u, SWYP_CAP_RIGHT_READ, &grant) == SWYP_ERR_DENIED);
    CHECK(swyp_capability_lookup(&table, handle, 7u, 11u, SWYP_CAP_RIGHT_WRITE, &grant) == SWYP_ERR_DENIED);
    CHECK(swyp_capability_mint(&table, &object, SWYP_CAP_RIGHT_CONTROL, 7u, 11u, &replacement) == SWYP_ERR_DENIED);
    CHECK(swyp_capability_revoke(&table, handle) == SWYP_OK);
    CHECK(swyp_capability_lookup(&table, handle, 7u, 11u, SWYP_CAP_RIGHT_READ, &grant) == SWYP_ERR_STALE);
    CHECK(swyp_capability_mint(&table, &object, SWYP_CAP_RIGHT_READ, 7u, 12u, &replacement) == SWYP_OK);
    CHECK(replacement != handle);
}

static void test_capability_generation_exhaustion(void) {
    SwypCapabilityTable table;
    SwypCapabilityObject object = {
        .type = SWYP_CAP_OBJECT_MMIO,
        .object_id = 1u,
        .base = 0x1000u,
        .length = 0x1000u,
    };
    SwypCapabilityHandle ancient = 0u;
    SwypCapabilityHandle max_generation = (UINT64_C(0xffffffff) << 32) | UINT64_C(1);
    SwypCapabilityHandle replacement = 0u;
    const SwypCapabilityGrant *grant = NULL;

    swyp_capability_table_init(&table);
    CHECK(swyp_capability_mint(&table, &object, SWYP_CAP_RIGHT_READ, 7u, 11u, &ancient) == SWYP_OK);
    table.entries[0].generation = UINT32_MAX;
    table.entries[0].active = SWYP_CAPABILITY_SLOT_ACTIVE;
    table.entries[0].grant.handle = max_generation;
    CHECK(swyp_capability_revoke(&table, max_generation) == SWYP_OK);
    CHECK(table.entries[0].active == SWYP_CAPABILITY_SLOT_RETIRED);
    CHECK(table.entries[0].generation == UINT32_MAX);
    CHECK(swyp_capability_mint(&table, &object, SWYP_CAP_RIGHT_READ, 7u, 11u, &replacement) == SWYP_OK);
    CHECK((uint32_t)replacement == 2u);
    CHECK(replacement != ancient);
    CHECK(swyp_capability_lookup(&table, ancient, 7u, 11u, SWYP_CAP_RIGHT_READ, &grant) == SWYP_ERR_STALE);
}

static uint32_t active_capability_count(const SwypCapabilityTable *table) {
    uint32_t count = 0u;
    uint32_t i;
    for (i = 0; i < SWYP_CAPABILITY_TABLE_CAPACITY; ++i) {
        if (table->entries[i].active == SWYP_CAPABILITY_SLOT_ACTIVE) {
            count += 1u;
        }
    }
    return count;
}

typedef struct FakeDeviceBackend {
    uint64_t next_token;
    uint32_t mmio_maps;
    uint32_t mmio_unmaps;
    uint32_t irq_binds;
    uint32_t irq_acks;
    uint32_t irq_unbinds;
    uint32_t dma_maps;
    uint32_t dma_unmaps;
    uint32_t config_reads;
    uint32_t config_writes;
    uint32_t control_reads;
    uint32_t control_writes;
    uint64_t last_mmu_flags;
    uint64_t last_offset;
    uint64_t last_length;
    uint64_t last_access_rights;
    uint64_t last_dma_physical;
    uint64_t last_config_offset;
    uint32_t last_config_width;
    uint64_t last_control_value;
    int fail_mmio_unmap;
} FakeDeviceBackend;

static uint64_t fake_next_token(FakeDeviceBackend *backend) {
    backend->next_token += 1u;
    if (backend->next_token == 0u) {
        backend->next_token = 1u;
    }
    return backend->next_token;
}

static SwypStatus fake_map_mmio(void *context, const SwypCapabilityObject *object, uint64_t domain_id,
                                uint64_t lease_fence, uint64_t offset, uint64_t length, uint64_t mmu_flags,
                                uint64_t *backend_token, uint64_t *virtual_address) {
    FakeDeviceBackend *backend = (FakeDeviceBackend *)context;
    uint64_t token;
    if (backend == NULL || object == NULL || backend_token == NULL || virtual_address == NULL || domain_id == 0u ||
        lease_fence == 0u || object->type != SWYP_CAP_OBJECT_MMIO) {
        return SWYP_ERR_INVALID;
    }
    token = fake_next_token(backend);
    backend->mmio_maps += 1u;
    backend->last_mmu_flags = mmu_flags;
    backend->last_offset = offset;
    backend->last_length = length;
    *backend_token = token;
    *virtual_address = UINT64_C(0x70000000) + token * UINT64_C(0x10000);
    return SWYP_OK;
}

static SwypStatus fake_unmap_mmio(void *context, uint64_t backend_token) {
    FakeDeviceBackend *backend = (FakeDeviceBackend *)context;
    if (backend == NULL || backend_token == 0u) {
        return SWYP_ERR_INVALID;
    }
    backend->mmio_unmaps += 1u;
    if (backend->fail_mmio_unmap) {
        return SWYP_ERR_CORRUPT;
    }
    return SWYP_OK;
}

static SwypStatus fake_bind_irq(void *context, const SwypCapabilityObject *object, uint64_t domain_id,
                                uint64_t lease_fence, uint64_t *backend_token, uint32_t *vector) {
    FakeDeviceBackend *backend = (FakeDeviceBackend *)context;
    uint64_t token;
    if (backend == NULL || object == NULL || backend_token == NULL || vector == NULL || domain_id == 0u ||
        lease_fence == 0u || object->type != SWYP_CAP_OBJECT_INTERRUPT || object->base > UINT32_MAX) {
        return SWYP_ERR_INVALID;
    }
    token = fake_next_token(backend);
    backend->irq_binds += 1u;
    *backend_token = token;
    *vector = (uint32_t)object->base + 32u;
    return SWYP_OK;
}

static SwypStatus fake_ack_irq(void *context, uint64_t backend_token) {
    FakeDeviceBackend *backend = (FakeDeviceBackend *)context;
    if (backend == NULL || backend_token == 0u) {
        return SWYP_ERR_INVALID;
    }
    backend->irq_acks += 1u;
    return SWYP_OK;
}

static SwypStatus fake_unbind_irq(void *context, uint64_t backend_token) {
    FakeDeviceBackend *backend = (FakeDeviceBackend *)context;
    if (backend == NULL || backend_token == 0u) {
        return SWYP_ERR_INVALID;
    }
    backend->irq_unbinds += 1u;
    return SWYP_OK;
}

static SwypStatus fake_map_dma(void *context, const SwypCapabilityObject *dma_object,
                               const SwypCapabilityObject *memory_object, uint64_t physical_address,
                               uint64_t domain_id, uint64_t lease_fence, uint64_t length, uint64_t access_rights,
                               uint64_t *backend_token, uint64_t *iova) {
    FakeDeviceBackend *backend = (FakeDeviceBackend *)context;
    uint64_t token;
    if (backend == NULL || dma_object == NULL || memory_object == NULL || backend_token == NULL || iova == NULL ||
        domain_id == 0u || lease_fence == 0u || dma_object->type != SWYP_CAP_OBJECT_DMA ||
        memory_object->type != SWYP_CAP_OBJECT_SHARED_MEMORY) {
        return SWYP_ERR_INVALID;
    }
    token = fake_next_token(backend);
    backend->dma_maps += 1u;
    backend->last_length = length;
    backend->last_access_rights = access_rights;
    backend->last_dma_physical = physical_address;
    *backend_token = token;
    *iova = dma_object->base;
    return SWYP_OK;
}

static SwypStatus fake_unmap_dma(void *context, uint64_t backend_token) {
    FakeDeviceBackend *backend = (FakeDeviceBackend *)context;
    if (backend == NULL || backend_token == 0u) {
        return SWYP_ERR_INVALID;
    }
    backend->dma_unmaps += 1u;
    return SWYP_OK;
}

static SwypStatus fake_config_read(void *context, const SwypCapabilityObject *object, uint64_t absolute_offset,
                                   uint32_t width_bytes, uint64_t *value) {
    FakeDeviceBackend *backend = (FakeDeviceBackend *)context;
    if (backend == NULL || object == NULL || value == NULL || object->type != SWYP_CAP_OBJECT_DEVICE_CONFIG) {
        return SWYP_ERR_INVALID;
    }
    backend->config_reads += 1u;
    backend->last_config_offset = absolute_offset;
    backend->last_config_width = width_bytes;
    *value = UINT64_C(0xa5a50000) | absolute_offset;
    return SWYP_OK;
}

static SwypStatus fake_config_write(void *context, const SwypCapabilityObject *object, uint64_t absolute_offset,
                                    uint32_t width_bytes, uint64_t value) {
    FakeDeviceBackend *backend = (FakeDeviceBackend *)context;
    (void)value;
    if (backend == NULL || object == NULL || object->type != SWYP_CAP_OBJECT_DEVICE_CONFIG) {
        return SWYP_ERR_INVALID;
    }
    backend->config_writes += 1u;
    backend->last_config_offset = absolute_offset;
    backend->last_config_width = width_bytes;
    return SWYP_OK;
}

static SwypStatus fake_control_read(void *context, const SwypCapabilityObject *object, uint64_t *value) {
    FakeDeviceBackend *backend = (FakeDeviceBackend *)context;
    if (backend == NULL || object == NULL || value == NULL || object->type != SWYP_CAP_OBJECT_DEVICE_CONTROL) {
        return SWYP_ERR_INVALID;
    }
    backend->control_reads += 1u;
    *value = object->aux;
    return SWYP_OK;
}

static SwypStatus fake_control_write(void *context, const SwypCapabilityObject *object, uint64_t value) {
    FakeDeviceBackend *backend = (FakeDeviceBackend *)context;
    if (backend == NULL || object == NULL || object->type != SWYP_CAP_OBJECT_DEVICE_CONTROL) {
        return SWYP_ERR_INVALID;
    }
    backend->control_writes += 1u;
    backend->last_control_value = value;
    return SWYP_OK;
}

static const SwypDeviceBrokerOps fake_device_ops = {
    .map_mmio = fake_map_mmio,
    .unmap_mmio = fake_unmap_mmio,
    .bind_irq = fake_bind_irq,
    .ack_irq = fake_ack_irq,
    .unbind_irq = fake_unbind_irq,
    .map_dma = fake_map_dma,
    .unmap_dma = fake_unmap_dma,
    .config_read = fake_config_read,
    .config_write = fake_config_write,
    .control_read = fake_control_read,
    .control_write = fake_control_write,
};

static void test_device_broker(void) {
    SwypCapabilityTable table;
    SwypDriverDomainManager domains;
    SwypDriverDomainPolicy policy;
    SwypDeviceBroker broker;
    FakeDeviceBackend backend = {0};
    SwypDeviceGraph graph;
    SwypDeviceNode nic = {
        .id = 2u,
        .device_class = SWYP_DEVICE_CLASS_NETWORK,
        .bus = SWYP_DEVICE_BUS_PCI,
    };
    SwypDeviceResource mmio = {
        .node_id = 2u,
        .kind = SWYP_DEVICE_RESOURCE_MMIO,
        .start = UINT64_C(0xfebf0000),
        .length = UINT64_C(0x1000),
    };
    SwypDeviceResource irq = {
        .node_id = 2u,
        .kind = SWYP_DEVICE_RESOURCE_IRQ,
        .start = 17u,
        .length = 1u,
    };
    SwypDeviceResource dma = {
        .node_id = 2u,
        .kind = SWYP_DEVICE_RESOURCE_DMA,
        .start = UINT64_C(0x20000000),
        .length = UINT64_C(0x4000),
    };
    SwypDeviceResource config = {
        .node_id = 2u,
        .kind = SWYP_DEVICE_RESOURCE_CONFIG,
        .start = UINT64_C(0x40),
        .length = UINT64_C(0x40),
    };
    SwypDeviceResource control = {
        .node_id = 2u,
        .kind = SWYP_DEVICE_RESOURCE_CLOCK_RESET_POWER,
        .start = 3u,
        .length = 1u,
        .aux = 9u,
    };
    SwypDeviceResource shared = {
        .node_id = 2u,
        .kind = SWYP_DEVICE_RESOURCE_SHARED_MEMORY,
        .start = UINT64_C(0x30000000),
        .length = UINT64_C(0x4000),
    };
    const SwypDriverDomain *domain = NULL;
    SwypDeviceMapping mmio_mapping;
    SwypDeviceMapping second_mmio_mapping;
    SwypDeviceMapping dma_mapping;
    SwypDeviceIrqBinding irq_binding;
    uint64_t config_value = 0u;
    uint64_t control_value = 0u;
    SwypDeviceBrokerHandle stale_mmio = 0u;

    swyp_device_graph_init(&graph);
    CHECK(swyp_device_graph_add_node(&graph, &nic) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&graph, &mmio) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&graph, &irq) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&graph, &dma) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&graph, &config) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&graph, &control) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&graph, &shared) == SWYP_OK);

    swyp_capability_table_init(&table);
    swyp_driver_domain_manager_init(&domains, &table);
    swyp_driver_domain_policy_init(&policy);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(&policy, &graph, &mmio,
                                                         SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_MAP) == SWYP_OK);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(&policy, &graph, &irq,
                                                         SWYP_CAP_RIGHT_BIND | SWYP_CAP_RIGHT_ACK) == SWYP_OK);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(
              &policy, &graph, &dma, SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE | SWYP_CAP_RIGHT_MAP) == SWYP_OK);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(&policy, &graph, &config, SWYP_CAP_RIGHT_READ) == SWYP_OK);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(&policy, &graph, &control,
                                                         SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_CONTROL) == SWYP_OK);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(
              &policy, &graph, &shared, SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE | SWYP_CAP_RIGHT_MAP) == SWYP_OK);
    CHECK(swyp_driver_domain_open(&domains, &graph, 2u, 700u, 11u, &policy, &domain) == SWYP_OK);
    CHECK(domain != NULL && domain->grant_count == 6u);

    swyp_device_broker_init(&broker, &domains, &backend, &fake_device_ops);
    CHECK(swyp_device_broker_map_mmio(&broker, 700u, 11u, domain->grants[0], 0x100u, 0x200u,
                                      SWYP_CAP_RIGHT_READ, &mmio_mapping) == SWYP_OK);
    CHECK(mmio_mapping.handle != 0u && mmio_mapping.address != 0u && mmio_mapping.length == 0x200u);
    CHECK(backend.mmio_maps == 1u && backend.last_offset == 0x100u && backend.last_length == 0x200u);
    CHECK((backend.last_mmu_flags & (SWYP_MMU_READ | SWYP_MMU_USER | SWYP_MMU_DEVICE)) ==
          (SWYP_MMU_READ | SWYP_MMU_USER | SWYP_MMU_DEVICE));
    CHECK((backend.last_mmu_flags & SWYP_MMU_WRITE) == 0u);
    CHECK(swyp_device_broker_map_mmio(&broker, 700u, 11u, domain->grants[0], 0u, 0x100u,
                                      SWYP_CAP_RIGHT_WRITE, &second_mmio_mapping) == SWYP_ERR_DENIED);
    CHECK(swyp_device_broker_map_mmio(&broker, 700u, 12u, domain->grants[0], 0u, 0x100u,
                                      SWYP_CAP_RIGHT_READ, &second_mmio_mapping) == SWYP_ERR_DENIED);
    CHECK(swyp_device_broker_map_mmio(&broker, 700u, 11u, domain->grants[0], 0xf80u, 0x100u,
                                      SWYP_CAP_RIGHT_READ, &second_mmio_mapping) == SWYP_ERR_DENIED);
    CHECK(backend.mmio_maps == 1u);

    stale_mmio = mmio_mapping.handle;
    CHECK(swyp_device_broker_unmap_mmio(&broker, 700u, 11u, mmio_mapping.handle) == SWYP_OK);
    CHECK(backend.mmio_unmaps == 1u);
    CHECK(swyp_device_broker_unmap_mmio(&broker, 700u, 11u, stale_mmio) == SWYP_ERR_STALE);
    CHECK(swyp_device_broker_map_mmio(&broker, 700u, 11u, domain->grants[0], 0u, 0x100u,
                                      SWYP_CAP_RIGHT_READ, &second_mmio_mapping) == SWYP_OK);
    CHECK(second_mmio_mapping.handle != stale_mmio);

    CHECK(swyp_device_broker_bind_irq(&broker, 700u, 11u, domain->grants[1], &irq_binding) == SWYP_OK);
    CHECK(irq_binding.handle != 0u && irq_binding.vector == 49u && backend.irq_binds == 1u);
    CHECK(swyp_device_broker_ack_irq(&broker, 700u, 12u, irq_binding.handle) == SWYP_ERR_DENIED);
    CHECK(swyp_device_broker_ack_irq(&broker, 700u, 11u, irq_binding.handle) == SWYP_OK);
    CHECK(backend.irq_acks == 1u);

    CHECK(swyp_device_broker_map_dma(&broker, 700u, 11u, domain->grants[2], domain->grants[5], 0x1000u, 0x2000u,
                                     SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE, &dma_mapping) == SWYP_OK);
    CHECK(dma_mapping.handle != 0u && dma_mapping.address == dma.start && dma_mapping.length == 0x2000u);
    CHECK(backend.dma_maps == 1u && backend.last_access_rights == (SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE));
    CHECK(backend.last_dma_physical == shared.start + UINT64_C(0x1000));
    CHECK(swyp_device_broker_map_dma(&broker, 700u, 11u, domain->grants[2], domain->grants[5], 0x3000u, 0x2000u,
                                     SWYP_CAP_RIGHT_READ, &dma_mapping) == SWYP_ERR_DENIED);
    CHECK(swyp_device_broker_map_dma(&broker, 700u, 11u, domain->grants[2], domain->grants[3], 0u, 0x1000u,
                                     SWYP_CAP_RIGHT_READ, &dma_mapping) == SWYP_ERR_DENIED);
    CHECK(backend.dma_maps == 1u);

    CHECK(swyp_device_broker_config_read(&broker, 700u, 11u, domain->grants[3], 4u, 4u, &config_value) == SWYP_OK);
    CHECK(config_value == (UINT64_C(0xa5a50000) | UINT64_C(0x44)));
    CHECK(backend.config_reads == 1u && backend.last_config_offset == 0x44u && backend.last_config_width == 4u);
    CHECK(swyp_device_broker_config_read(&broker, 700u, 11u, domain->grants[3], 0x3fu, 4u, &config_value) ==
          SWYP_ERR_DENIED);
    CHECK(swyp_device_broker_config_read(&broker, 700u, 11u, domain->grants[3], 1u, 2u, &config_value) ==
          SWYP_ERR_DENIED);
    CHECK(swyp_device_broker_config_write(&broker, 700u, 11u, domain->grants[3], 0u, 4u, 1u) == SWYP_ERR_DENIED);
    CHECK(backend.config_writes == 0u);

    CHECK(swyp_device_broker_control_read(&broker, 700u, 11u, domain->grants[4], &control_value) == SWYP_OK);
    CHECK(control_value == control.aux && backend.control_reads == 1u);
    CHECK(swyp_device_broker_control_write(&broker, 700u, 11u, domain->grants[4], 42u) == SWYP_OK);
    CHECK(backend.control_writes == 1u && backend.last_control_value == 42u);

    CHECK(swyp_device_broker_revoke_domain(&broker, 700u, 11u) == SWYP_OK);
    CHECK(backend.mmio_unmaps == 2u);
    CHECK(backend.irq_unbinds == 1u);
    CHECK(backend.dma_unmaps == 1u);
    CHECK(swyp_device_broker_ack_irq(&broker, 700u, 11u, irq_binding.handle) == SWYP_ERR_STALE);

    swyp_driver_domain_policy_init(&policy);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(&policy, &graph, &mmio,
                                                         SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_MAP) == SWYP_OK);
    CHECK(swyp_driver_domain_open(&domains, &graph, 2u, 700u, 12u, &policy, &domain) == SWYP_OK);
    CHECK(swyp_device_broker_map_mmio(&broker, 700u, 12u, domain->grants[0], 0u, 0x100u,
                                      SWYP_CAP_RIGHT_READ, &mmio_mapping) == SWYP_OK);
    backend.fail_mmio_unmap = 1;
    CHECK(swyp_device_broker_revoke_domain(&broker, 700u, 12u) == SWYP_ERR_CORRUPT);
    CHECK(domain->active == SWYP_DRIVER_DOMAIN_QUIESCED);
    CHECK(swyp_device_broker_map_mmio(&broker, 700u, 12u, domain->grants[0], 0u, 0x100u,
                                      SWYP_CAP_RIGHT_READ, &second_mmio_mapping) == SWYP_ERR_DENIED);
    backend.fail_mmio_unmap = 0;
    CHECK(swyp_device_broker_revoke_domain(&broker, 700u, 12u) == SWYP_OK);
}

typedef struct FakePlatformRuntime {
    SwypAddressSpace address_space;
    SwypInterruptSource interrupts;
    uint32_t address_space_queries;
    uint32_t va_reserves;
    uint32_t va_releases;
    uint32_t as_maps;
    uint32_t as_unmaps;
    uint32_t vector_allocs;
    uint32_t vector_releases;
    uint32_t irq_binds;
    uint32_t irq_controller_unbinds;
    uint32_t irq_masks;
    uint32_t irq_unmasks;
    uint32_t irq_eois;
    uint64_t last_virtual;
    uint64_t last_physical;
    uint64_t last_pages;
    uint64_t last_mmu_flags;
    uint32_t last_source;
    uint32_t last_vector;
} FakePlatformRuntime;

static SwypStatus fake_platform_as_map(void *context, uint64_t virtual_address, uint64_t physical_address,
                                       uint64_t page_count, uint64_t flags) {
    FakePlatformRuntime *runtime = (FakePlatformRuntime *)context;
    if (runtime == NULL || virtual_address == 0u || page_count == 0u) {
        return SWYP_ERR_INVALID;
    }
    runtime->as_maps += 1u;
    runtime->last_virtual = virtual_address;
    runtime->last_physical = physical_address;
    runtime->last_pages = page_count;
    runtime->last_mmu_flags = flags;
    return SWYP_OK;
}

static SwypStatus fake_platform_as_unmap(void *context, uint64_t virtual_address, uint64_t page_count) {
    FakePlatformRuntime *runtime = (FakePlatformRuntime *)context;
    if (runtime == NULL || virtual_address == 0u || page_count == 0u) {
        return SWYP_ERR_INVALID;
    }
    runtime->as_unmaps += 1u;
    runtime->last_virtual = virtual_address;
    runtime->last_pages = page_count;
    return SWYP_OK;
}

static const SwypAddressSpaceOps fake_platform_address_space_ops = {
    .map = fake_platform_as_map,
    .unmap = fake_platform_as_unmap,
};

static SwypStatus fake_platform_irq_bind(void *context, uint32_t source_id, uint32_t vector) {
    FakePlatformRuntime *runtime = (FakePlatformRuntime *)context;
    if (runtime == NULL || vector == 0u) {
        return SWYP_ERR_INVALID;
    }
    runtime->irq_binds += 1u;
    runtime->last_source = source_id;
    runtime->last_vector = vector;
    return SWYP_OK;
}

static SwypStatus fake_platform_irq_unbind(void *context, uint32_t source_id) {
    FakePlatformRuntime *runtime = (FakePlatformRuntime *)context;
    if (runtime == NULL) {
        return SWYP_ERR_INVALID;
    }
    runtime->irq_controller_unbinds += 1u;
    runtime->last_source = source_id;
    return SWYP_OK;
}

static SwypStatus fake_platform_irq_mask(void *context, uint32_t source_id) {
    FakePlatformRuntime *runtime = (FakePlatformRuntime *)context;
    if (runtime == NULL) {
        return SWYP_ERR_INVALID;
    }
    runtime->irq_masks += 1u;
    runtime->last_source = source_id;
    return SWYP_OK;
}

static SwypStatus fake_platform_irq_unmask(void *context, uint32_t source_id) {
    FakePlatformRuntime *runtime = (FakePlatformRuntime *)context;
    if (runtime == NULL) {
        return SWYP_ERR_INVALID;
    }
    runtime->irq_unmasks += 1u;
    runtime->last_source = source_id;
    return SWYP_OK;
}

static SwypStatus fake_platform_irq_eoi(void *context, uint32_t source_id) {
    FakePlatformRuntime *runtime = (FakePlatformRuntime *)context;
    if (runtime == NULL) {
        return SWYP_ERR_INVALID;
    }
    runtime->irq_eois += 1u;
    runtime->last_source = source_id;
    return SWYP_OK;
}

static const SwypInterruptSourceOps fake_platform_interrupt_ops = {
    .bind = fake_platform_irq_bind,
    .unbind = fake_platform_irq_unbind,
    .mask = fake_platform_irq_mask,
    .unmask = fake_platform_irq_unmask,
    .end_of_interrupt = fake_platform_irq_eoi,
};

static SwypStatus fake_platform_address_space_for_domain(void *context, uint64_t domain_id, uint64_t lease_fence,
                                                         SwypAddressSpace **out_address_space) {
    FakePlatformRuntime *runtime = (FakePlatformRuntime *)context;
    if (runtime == NULL || out_address_space == NULL) {
        return SWYP_ERR_INVALID;
    }
    runtime->address_space_queries += 1u;
    if (domain_id != 700u || lease_fence != 11u) {
        return SWYP_ERR_DENIED;
    }
    *out_address_space = &runtime->address_space;
    return SWYP_OK;
}

static SwypStatus fake_platform_reserve_va(void *context, uint64_t domain_id, uint64_t lease_fence,
                                           uint64_t page_count, uint32_t page_shift, uint64_t *virtual_base) {
    FakePlatformRuntime *runtime = (FakePlatformRuntime *)context;
    if (runtime == NULL || virtual_base == NULL || domain_id != 700u || lease_fence != 11u || page_count == 0u ||
        page_shift != 12u) {
        return SWYP_ERR_INVALID;
    }
    runtime->va_reserves += 1u;
    *virtual_base = UINT64_C(0x90000000) + (uint64_t)(runtime->va_reserves - 1u) * UINT64_C(0x10000);
    return SWYP_OK;
}

static SwypStatus fake_platform_release_va(void *context, uint64_t domain_id, uint64_t lease_fence,
                                           uint64_t virtual_base, uint64_t page_count) {
    FakePlatformRuntime *runtime = (FakePlatformRuntime *)context;
    if (runtime == NULL || domain_id != 700u || lease_fence != 11u || virtual_base == 0u || page_count == 0u) {
        return SWYP_ERR_INVALID;
    }
    runtime->va_releases += 1u;
    return SWYP_OK;
}

static SwypStatus fake_platform_allocate_vector(void *context, uint64_t domain_id, uint64_t lease_fence,
                                                uint32_t source_id, uint32_t *vector) {
    FakePlatformRuntime *runtime = (FakePlatformRuntime *)context;
    if (runtime == NULL || vector == NULL || domain_id != 700u || lease_fence != 11u) {
        return SWYP_ERR_INVALID;
    }
    runtime->vector_allocs += 1u;
    runtime->last_source = source_id;
    *vector = 80u;
    return SWYP_OK;
}

static SwypStatus fake_platform_release_vector(void *context, uint64_t domain_id, uint64_t lease_fence,
                                               uint32_t source_id, uint32_t vector) {
    FakePlatformRuntime *runtime = (FakePlatformRuntime *)context;
    if (runtime == NULL || domain_id != 700u || lease_fence != 11u || vector != 80u) {
        return SWYP_ERR_INVALID;
    }
    runtime->vector_releases += 1u;
    runtime->last_source = source_id;
    runtime->last_vector = vector;
    return SWYP_OK;
}

static const SwypDevicePlatformRuntimeOps fake_platform_runtime_ops = {
    .address_space_for_domain = fake_platform_address_space_for_domain,
    .reserve_device_virtual = fake_platform_reserve_va,
    .release_device_virtual = fake_platform_release_va,
    .allocate_irq_vector = fake_platform_allocate_vector,
    .release_irq_vector = fake_platform_release_vector,
};

static void test_device_platform(void) {
    SwypCapabilityTable table;
    SwypDriverDomainManager domains;
    SwypDriverDomainPolicy policy;
    SwypDeviceBroker broker;
    SwypDevicePlatform platform;
    FakePlatformRuntime runtime = {0};
    SwypDeviceGraph graph;
    SwypDeviceNode nic = {
        .id = 2u,
        .device_class = SWYP_DEVICE_CLASS_NETWORK,
        .bus = SWYP_DEVICE_BUS_PCI,
    };
    SwypDeviceResource mmio = {
        .node_id = 2u,
        .kind = SWYP_DEVICE_RESOURCE_MMIO,
        .start = UINT64_C(0xfebf0123),
        .length = UINT64_C(0x3000),
    };
    SwypDeviceResource irq = {
        .node_id = 2u,
        .kind = SWYP_DEVICE_RESOURCE_IRQ,
        .start = 17u,
        .length = 1u,
    };
    const SwypDriverDomain *domain = NULL;
    SwypDeviceMapping mapping;
    SwypDeviceIrqBinding binding;
    uint64_t expected_physical = UINT64_C(0xfebf0000);
    uint64_t expected_offset = UINT64_C(0x143);

    runtime.address_space.context = &runtime;
    runtime.address_space.ops = &fake_platform_address_space_ops;
    runtime.interrupts.context = &runtime;
    runtime.interrupts.ops = &fake_platform_interrupt_ops;

    swyp_device_graph_init(&graph);
    CHECK(swyp_device_graph_add_node(&graph, &nic) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&graph, &mmio) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&graph, &irq) == SWYP_OK);
    swyp_capability_table_init(&table);
    swyp_driver_domain_manager_init(&domains, &table);
    swyp_driver_domain_policy_init(&policy);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(&policy, &graph, &mmio,
                                                         SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_MAP) == SWYP_OK);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(&policy, &graph, &irq,
                                                         SWYP_CAP_RIGHT_BIND | SWYP_CAP_RIGHT_ACK) == SWYP_OK);
    CHECK(swyp_driver_domain_open(&domains, &graph, 2u, 700u, 11u, &policy, &domain) == SWYP_OK);

    swyp_device_platform_init(&platform, &runtime, &fake_platform_runtime_ops, &runtime.interrupts, 12u);
    swyp_device_broker_init(&broker, &domains, &platform, swyp_device_platform_broker_ops());

    CHECK(swyp_device_broker_map_mmio(&broker, 700u, 11u, domain->grants[0], 0x20u, 0x1800u,
                                      SWYP_CAP_RIGHT_READ, &mapping) == SWYP_OK);
    CHECK(runtime.address_space_queries == 1u && runtime.va_reserves == 1u && runtime.as_maps == 1u);
    CHECK(runtime.last_physical == expected_physical);
    CHECK(runtime.last_pages == 2u);
    CHECK(mapping.address == UINT64_C(0x90000000) + expected_offset);
    CHECK((runtime.last_mmu_flags & (SWYP_MMU_READ | SWYP_MMU_USER | SWYP_MMU_DEVICE)) ==
          (SWYP_MMU_READ | SWYP_MMU_USER | SWYP_MMU_DEVICE));
    CHECK((runtime.last_mmu_flags & (SWYP_MMU_WRITE | SWYP_MMU_EXECUTE | SWYP_MMU_GLOBAL)) == 0u);
    CHECK(swyp_device_broker_unmap_mmio(&broker, 700u, 11u, mapping.handle) == SWYP_OK);
    CHECK(runtime.as_unmaps == 1u && runtime.va_releases == 1u);

    CHECK(swyp_device_broker_bind_irq(&broker, 700u, 11u, domain->grants[1], &binding) == SWYP_OK);
    CHECK(binding.vector == 80u && runtime.vector_allocs == 1u && runtime.irq_binds == 1u && runtime.irq_unmasks == 1u);
    CHECK(runtime.last_source == 17u && runtime.last_vector == 80u);
    CHECK(swyp_device_broker_ack_irq(&broker, 700u, 11u, binding.handle) == SWYP_OK);
    CHECK(runtime.irq_eois == 1u);
    CHECK(swyp_device_broker_unbind_irq(&broker, 700u, 11u, binding.handle) == SWYP_OK);
    CHECK(runtime.irq_masks == 1u && runtime.irq_controller_unbinds == 1u && runtime.vector_releases == 1u);

    CHECK(swyp_device_broker_revoke_domain(&broker, 700u, 11u) == SWYP_OK);
}

static void build_test_driver_image(uint8_t *image, uint64_t image_bytes) {
    if (image == NULL || image_bytes < UINT64_C(0x200)) {
        return;
    }
    memset(image, 0, (size_t)image_bytes);
    image[0] = 'S';
    image[1] = 'W';
    image[2] = 'Y';
    image[3] = 'D';
    image[4] = 'R';
    image[5] = 'V';
    image[6] = '1';
    image[7] = 0u;
    test_put_u16(image + 8u, SWYP_X86_DRIVER_IMAGE_VERSION);
    test_put_u16(image + 10u, SWYP_X86_DRIVER_IMAGE_HEADER_BYTES);
    test_put_u16(image + 12u, 2u);
    test_put_u64(image + 24u, UINT64_C(0x100));
    test_put_u64(image + 32u, UINT64_C(0x3000));

    test_put_u64(image + 64u + 0u, 0u);
    test_put_u64(image + 64u + 8u, UINT64_C(0x100));
    test_put_u64(image + 64u + 16u, 4u);
    test_put_u64(image + 64u + 24u, UINT64_C(0x1000));
    test_put_u64(image + 64u + 32u, SWYP_X86_DRIVER_SEGMENT_READ | SWYP_X86_DRIVER_SEGMENT_EXECUTE);

    test_put_u64(image + 112u + 0u, UINT64_C(0x2000));
    test_put_u64(image + 112u + 8u, UINT64_C(0x110));
    test_put_u64(image + 112u + 16u, 4u);
    test_put_u64(image + 112u + 24u, UINT64_C(0x1000));
    test_put_u64(image + 112u + 32u, SWYP_X86_DRIVER_SEGMENT_READ | SWYP_X86_DRIVER_SEGMENT_WRITE);

    image[0x100] = UINT8_C(0x90);
    image[0x101] = UINT8_C(0x90);
    image[0x102] = UINT8_C(0x90);
    image[0x103] = UINT8_C(0xc3);
    image[0x110] = UINT8_C(0xde);
    image[0x111] = UINT8_C(0xad);
    image[0x112] = UINT8_C(0xbe);
    image[0x113] = UINT8_C(0xef);
}

static void test_x86_driver_image_parser_and_loader(void) {
    uint8_t image[0x200];
    uint8_t invalid[0x200];
    FakeX86PagePool pool = {0};
    FakeX86Hardware hardware = {.pool = &pool};
    SwypPageAllocator allocator = {.context = &pool, .ops = &fake_x86_allocator_ops};
    SwypX86DriverRuntimeManager runtime;
    SwypAddressSpace *address_space = NULL;
    SwypX86AddressSpace *space;
    SwypX86DriverImageInfo info;
    SwypX86LoadedDriverImage loaded;
    SwypThreadContext initial_context;
    SwypX86_64ThreadContext *x86_context;
    uint64_t physical = 0u;
    uint64_t flags = 0u;
    uint32_t page_index = 0u;

    build_test_driver_image(image, sizeof(image));
    CHECK(swyp_x86_driver_image_parse(image, sizeof(image), &info) == SWYP_OK);
    CHECK(info.segment_count == 2u && info.total_pages == 2u && info.entry_rva == UINT64_C(0x100) &&
          info.image_span == UINT64_C(0x3000));

    memcpy(invalid, image, sizeof(invalid));
    test_put_u64(invalid + 64u + 32u,
                 SWYP_X86_DRIVER_SEGMENT_READ | SWYP_X86_DRIVER_SEGMENT_WRITE |
                     SWYP_X86_DRIVER_SEGMENT_EXECUTE);
    CHECK(swyp_x86_driver_image_parse(invalid, sizeof(invalid), &info) == SWYP_ERR_CORRUPT);
    memcpy(invalid, image, sizeof(invalid));
    test_put_u64(invalid + 24u, UINT64_C(0x1000));
    CHECK(swyp_x86_driver_image_parse(invalid, sizeof(invalid), &info) == SWYP_ERR_CORRUPT);
    memcpy(invalid, image, sizeof(invalid));
    test_put_u64(invalid + 112u, 0u);
    CHECK(swyp_x86_driver_image_parse(invalid, sizeof(invalid), &info) == SWYP_ERR_CORRUPT);
    memcpy(invalid, image, sizeof(invalid));
    test_put_u64(invalid + 64u + 40u, 1u);
    CHECK(swyp_x86_driver_image_parse(invalid, sizeof(invalid), &info) == SWYP_ERR_CORRUPT);

    swyp_x86_64_driver_runtime_init(&runtime, &allocator, &hardware, &fake_x86_hardware_ops);
    CHECK(swyp_x86_64_driver_runtime_open_domain(&runtime, 700u, 11u, &address_space) == SWYP_OK);
    CHECK(address_space != NULL);
    CHECK(swyp_x86_driver_image_load(&runtime, 700u, 11u, image, sizeof(image), 2u, &loaded,
                                     &initial_context) == SWYP_OK);
    CHECK(loaded.active != 0u && loaded.image_page_count == 2u && loaded.stack_page_count == 2u);
    CHECK(loaded.entry_address == SWYP_X86_DRIVER_IMAGE_BASE + UINT64_C(0x100) &&
          loaded.stack_pointer == SWYP_X86_DRIVER_STACK_TOP);
    CHECK(initial_context.abi_version == SWYP_KERNEL_ABI_VERSION && initial_context.arch == SWYP_ARCH_X86_64 &&
          initial_context.used_bytes == sizeof(SwypX86_64ThreadContext));
    x86_context = (SwypX86_64ThreadContext *)(void *)initial_context.storage;
    CHECK(x86_context->rip == loaded.entry_address && x86_context->rsp == SWYP_X86_DRIVER_STACK_TOP &&
          x86_context->rflags == SWYP_X86_DRIVER_INITIAL_RFLAGS);

    space = swyp_x86_64_driver_runtime_x86_space(&runtime, 700u, 11u);
    CHECK(space != NULL);
    CHECK(swyp_x86_64_address_space_query(space, SWYP_X86_DRIVER_IMAGE_BASE, &physical, &flags) == SWYP_OK);
    CHECK((flags & (SWYP_MMU_READ | SWYP_MMU_EXECUTE | SWYP_MMU_USER)) ==
          (SWYP_MMU_READ | SWYP_MMU_EXECUTE | SWYP_MMU_USER));
    CHECK((flags & SWYP_MMU_WRITE) == 0u);
    CHECK(fake_x86_page_index(physical, &page_index));
    CHECK(pool.pages[page_index][0] == UINT8_C(0x90) && pool.pages[page_index][3] == UINT8_C(0xc3) &&
          pool.pages[page_index][4] == 0u);

    CHECK(swyp_x86_64_address_space_query(space, SWYP_X86_DRIVER_IMAGE_BASE + UINT64_C(0x1000), &physical,
                                          &flags) == SWYP_ERR_NOT_FOUND);
    CHECK(swyp_x86_64_address_space_query(space, SWYP_X86_DRIVER_IMAGE_BASE + UINT64_C(0x2000), &physical,
                                          &flags) == SWYP_OK);
    CHECK((flags & (SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_USER)) ==
          (SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_USER));
    CHECK((flags & SWYP_MMU_EXECUTE) == 0u);
    CHECK(fake_x86_page_index(physical, &page_index));
    CHECK(pool.pages[page_index][0] == UINT8_C(0xde) && pool.pages[page_index][3] == UINT8_C(0xef) &&
          pool.pages[page_index][4] == 0u);

    CHECK(swyp_x86_64_address_space_query(space, SWYP_X86_DRIVER_STACK_TOP - SWYP_X86_64_PAGE_SIZE, &physical,
                                          &flags) == SWYP_OK);
    CHECK((flags & (SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_USER)) ==
          (SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_USER));
    CHECK((flags & SWYP_MMU_EXECUTE) == 0u);
    CHECK(swyp_x86_64_address_space_query(space, SWYP_X86_DRIVER_STACK_TOP - UINT64_C(3) * SWYP_X86_64_PAGE_SIZE,
                                          &physical, &flags) == SWYP_ERR_NOT_FOUND);

    hardware.current_root = space->pml4_physical;
    CHECK(swyp_x86_driver_image_unload(&runtime, &loaded) == SWYP_ERR_DENIED);
    hardware.current_root = 0u;
    CHECK(swyp_x86_driver_image_unload(&runtime, &loaded) == SWYP_OK);
    CHECK(loaded.active == 0u);
    CHECK(swyp_x86_64_driver_runtime_close_domain(&runtime, 700u, 11u) == SWYP_OK);
    CHECK(fake_x86_used_pages(&pool) == 0u);
}

static void test_x86_driver_runtime_end_to_end(void) {
    FakeX86PagePool pool = {0};
    FakeX86Hardware hardware = {.pool = &pool};
    SwypPageAllocator allocator = {.context = &pool, .ops = &fake_x86_allocator_ops};
    SwypX86DriverRuntimeManager runtime_manager;
    SwypCapabilityTable capability_table;
    SwypDriverDomainManager capability_domains;
    SwypDriverDomainPolicy policy;
    SwypDevicePlatform platform;
    SwypDeviceBroker broker;
    FakeApicHardware apic_hardware = {0};
    SwypX86Apic apic;
    FakeIommuHardware iommu_hardware = {0};
    SwypX86Iommu iommu;
    FakePciHardware pci_hardware = {.read_value = UINT32_C(0xaabbccdd)};
    SwypX86PciEcam pci;
    SwypX86PciEcamSegment pci_segment = {
        .segment = 0u,
        .start_bus = 0u,
        .end_bus = 255u,
        .physical_base = UINT64_C(0xe0000000),
    };
    SwypDeviceGraph graph;
    SwypDeviceNode nic = {
        .id = 2u,
        .device_class = SWYP_DEVICE_CLASS_NETWORK,
        .bus = SWYP_DEVICE_BUS_PCI,
    };
    SwypDeviceResource mmio = {
        .node_id = 2u,
        .kind = SWYP_DEVICE_RESOURCE_MMIO,
        .start = UINT64_C(0xfebf0123),
        .length = UINT64_C(0x2000),
    };
    SwypDeviceResource irq = {
        .node_id = 2u,
        .kind = SWYP_DEVICE_RESOURCE_IRQ,
        .start = 17u,
        .length = 1u,
    };
    SwypDeviceResource dma = {
        .node_id = 2u,
        .kind = SWYP_DEVICE_RESOURCE_DMA,
        .start = UINT64_C(0x20000000),
        .length = UINT64_C(0x4000),
    };
    SwypDeviceResource shared = {
        .node_id = 2u,
        .kind = SWYP_DEVICE_RESOURCE_SHARED_MEMORY,
        .start = UINT64_C(0x30000000),
        .length = UINT64_C(0x4000),
    };
    SwypDeviceResource config = {
        .node_id = 2u,
        .kind = SWYP_DEVICE_RESOURCE_CONFIG,
        .start = UINT64_C(0x40),
        .length = UINT64_C(0x40),
        .aux = 0u,
    };
    SwypAddressSpace *driver_address_space = NULL;
    const SwypDriverDomain *capability_domain = NULL;
    SwypDeviceMapping mapping;
    SwypDeviceMapping dma_mapping;
    SwypDeviceIrqBinding binding;
    SwypX86AddressSpace *x86_space;
    uint64_t mapped_physical = 0u;
    uint64_t mapped_flags = 0u;
    uint64_t config_value = 0u;
    uint64_t pci_function_base = UINT64_C(0xe0000000) + (UINT64_C(2) << 20) + (UINT64_C(3) << 15) +
                                 (UINT64_C(1) << 12);

    CHECK(swyp_x86_apic_init(&apic, &apic_hardware, &fake_apic_hardware_ops, 0u, 24u, 2u) == SWYP_OK);
    swyp_x86_iommu_init(&iommu, &iommu_hardware, &fake_iommu_hardware_ops);
    config.aux = swyp_x86_pci_config_aux(0u, 2u, 3u, 1u);
    CHECK(swyp_x86_pci_ecam_init(&pci, &pci_hardware, &fake_pci_hardware_ops, &pci_segment, 1u) == SWYP_OK);
    swyp_x86_64_driver_runtime_init(&runtime_manager, &allocator, &hardware, &fake_x86_hardware_ops);
    swyp_x86_64_driver_runtime_set_iommu(&runtime_manager, &iommu);
    swyp_x86_64_driver_runtime_set_pci_ecam(&runtime_manager, &pci);
    CHECK(swyp_x86_64_driver_runtime_open_domain(&runtime_manager, 700u, 11u, &driver_address_space) == SWYP_OK);
    CHECK(driver_address_space != NULL && fake_x86_used_pages(&pool) == 1u);
    CHECK(swyp_x86_64_driver_runtime_open_domain(&runtime_manager, 700u, 12u, &driver_address_space) == SWYP_ERR_DENIED);

    swyp_device_graph_init(&graph);
    CHECK(swyp_device_graph_add_node(&graph, &nic) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&graph, &mmio) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&graph, &irq) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&graph, &dma) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&graph, &shared) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&graph, &config) == SWYP_OK);
    swyp_capability_table_init(&capability_table);
    swyp_driver_domain_manager_init(&capability_domains, &capability_table);
    swyp_driver_domain_policy_init(&policy);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(&policy, &graph, &mmio,
                                                         SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_MAP) == SWYP_OK);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(&policy, &graph, &irq,
                                                         SWYP_CAP_RIGHT_BIND | SWYP_CAP_RIGHT_ACK) == SWYP_OK);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(
              &policy, &graph, &dma, SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE | SWYP_CAP_RIGHT_MAP) == SWYP_OK);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(
              &policy, &graph, &shared, SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE | SWYP_CAP_RIGHT_MAP) == SWYP_OK);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(&policy, &graph, &config,
                                                         SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE) == SWYP_OK);
    CHECK(swyp_driver_domain_open(&capability_domains, &graph, 2u, 700u, 11u, &policy, &capability_domain) == SWYP_OK);

    swyp_device_platform_init(&platform, &runtime_manager, swyp_x86_64_driver_runtime_platform_ops(),
                              swyp_x86_apic_contract(&apic), SWYP_X86_64_PAGE_SHIFT);
    swyp_device_broker_init(&broker, &capability_domains, &platform, swyp_device_platform_broker_ops());
    CHECK(swyp_device_broker_map_mmio(&broker, 700u, 12u, capability_domain->grants[0], 0x20u, 0x500u,
                                      SWYP_CAP_RIGHT_READ, &mapping) == SWYP_ERR_DENIED);
    CHECK(swyp_device_broker_map_mmio(&broker, 700u, 11u, capability_domain->grants[0], 0x20u, 0x500u,
                                      SWYP_CAP_RIGHT_READ, &mapping) == SWYP_OK);
    CHECK(mapping.address >= SWYP_X86_DRIVER_RUNTIME_VA_BASE && mapping.handle != 0u);
    x86_space = swyp_x86_64_driver_runtime_x86_space(&runtime_manager, 700u, 11u);
    CHECK(x86_space != NULL);
    CHECK(swyp_x86_64_address_space_query(x86_space, mapping.address, &mapped_physical, &mapped_flags) == SWYP_OK);
    CHECK(mapped_physical == mmio.start + UINT64_C(0x20));
    CHECK((mapped_flags & (SWYP_MMU_READ | SWYP_MMU_USER | SWYP_MMU_DEVICE)) ==
          (SWYP_MMU_READ | SWYP_MMU_USER | SWYP_MMU_DEVICE));
    CHECK((mapped_flags & (SWYP_MMU_WRITE | SWYP_MMU_EXECUTE | SWYP_MMU_GLOBAL)) == 0u);

    CHECK(swyp_device_broker_bind_irq(&broker, 700u, 11u, capability_domain->grants[1], &binding) == SWYP_OK);
    CHECK(binding.vector == SWYP_X86_DRIVER_RUNTIME_IRQ_FIRST);
    CHECK(apic_hardware.ioapic_regs[0x10u + 17u * 2u] == binding.vector);
    CHECK(apic_hardware.ioapic_regs[0x11u + 17u * 2u] == (UINT32_C(2) << 24));
    CHECK(swyp_device_broker_ack_irq(&broker, 700u, 11u, binding.handle) == SWYP_OK);
    CHECK(apic_hardware.lapic_writes == 1u && apic_hardware.last_lapic_offset == 0xB0u);
    CHECK(swyp_device_broker_map_dma(&broker, 700u, 11u, capability_domain->grants[2],
                                     capability_domain->grants[3], 0u, 0x2000u,
                                     SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE, &dma_mapping) == SWYP_OK);
    CHECK(dma_mapping.address == dma.start && dma_mapping.length == 0x2000u);
    CHECK(iommu_hardware.maps == 1u && iommu_hardware.last_physical == shared.start &&
          iommu_hardware.last_pages == 2u);
    CHECK(swyp_x86_iommu_domain_has_mappings(&iommu, 700u, 11u));
    CHECK(swyp_device_broker_config_read(&broker, 700u, 11u, capability_domain->grants[4], 4u, 4u,
                                         &config_value) == SWYP_OK);
    CHECK(config_value == UINT64_C(0xaabbccdd));
    CHECK(pci_hardware.last_read_address == pci_function_base + UINT64_C(0x44));
    CHECK(swyp_device_broker_config_write(&broker, 700u, 11u, capability_domain->grants[4], 8u, 4u,
                                          UINT64_C(0x12345678)) == SWYP_OK);
    CHECK(pci_hardware.last_write_address == pci_function_base + UINT64_C(0x48) &&
          pci_hardware.last_write_value == UINT32_C(0x12345678));
    CHECK(swyp_x86_64_driver_runtime_close_domain(&runtime_manager, 700u, 11u) == SWYP_ERR_DENIED);
    CHECK(swyp_device_broker_revoke_domain(&broker, 700u, 11u) == SWYP_OK);
    CHECK(!swyp_x86_iommu_domain_has_mappings(&iommu, 700u, 11u));
    CHECK(apic_hardware.ioapic_regs[0x10u + 17u * 2u] == (1u << 16));
    CHECK(apic_hardware.ioapic_regs[0x11u + 17u * 2u] == 0u);
    CHECK(swyp_x86_64_driver_runtime_close_domain(&runtime_manager, 700u, 11u) == SWYP_OK);
    CHECK(fake_x86_used_pages(&pool) == 0u);

    CHECK(swyp_x86_64_driver_runtime_open_domain(&runtime_manager, 700u, 12u, &driver_address_space) == SWYP_OK);
    CHECK(swyp_x86_64_driver_runtime_activate_domain(&runtime_manager, 700u, 11u) == SWYP_ERR_DENIED);
    CHECK(swyp_x86_64_driver_runtime_activate_domain(&runtime_manager, 700u, 12u) == SWYP_OK);
    CHECK(hardware.current_root != 0u);
    CHECK(swyp_x86_64_driver_runtime_close_domain(&runtime_manager, 700u, 12u) == SWYP_ERR_DENIED);
    hardware.current_root = 0u;
    CHECK(swyp_x86_64_driver_runtime_close_domain(&runtime_manager, 700u, 12u) == SWYP_OK);
    CHECK(fake_x86_used_pages(&pool) == 0u);
}

static void test_driver_domains(void) {
    SwypCapabilityTable table;
    SwypDriverDomainManager manager;
    SwypDriverDomainPolicy policy;
    SwypDriverDomainPolicy foreign_policy;
    SwypDriverDomainPolicy excessive_policy;
    SwypDeviceGraph graph;
    SwypDeviceNode root = {
        .id = 1u,
        .device_class = SWYP_DEVICE_CLASS_PLATFORM,
        .bus = SWYP_DEVICE_BUS_PLATFORM,
    };
    SwypDeviceNode nic = {
        .id = 2u,
        .parent_id = 1u,
        .device_class = SWYP_DEVICE_CLASS_NETWORK,
        .bus = SWYP_DEVICE_BUS_PCI,
    };
    SwypDeviceResource resources[] = {
        {.node_id = 2u, .kind = SWYP_DEVICE_RESOURCE_MMIO, .start = UINT64_C(0xfebf0000), .length = UINT64_C(0x1000)},
        {.node_id = 2u, .kind = SWYP_DEVICE_RESOURCE_IRQ, .start = 17u, .length = 1u},
        {.node_id = 2u, .kind = SWYP_DEVICE_RESOURCE_DMA, .start = UINT64_C(0x20000000), .length = UINT64_C(0x2000)},
        {.node_id = 2u, .kind = SWYP_DEVICE_RESOURCE_CONFIG, .start = 0u, .length = UINT64_C(0x100)},
        {.node_id = 2u, .kind = SWYP_DEVICE_RESOURCE_CLOCK_RESET_POWER, .start = 3u, .length = 1u},
        {.node_id = 1u, .kind = SWYP_DEVICE_RESOURCE_MMIO, .start = UINT64_C(0xfee00000), .length = UINT64_C(0x1000)},
    };
    const SwypDriverDomain *domain = NULL;
    const SwypDriverDomain *probe_domain = NULL;
    const SwypCapabilityGrant *grant = NULL;
    SwypCapabilityHandle old_mmio = 0u;
    SwypCapabilityHandle unrelated = 0u;
    SwypCapabilityObject unrelated_object = {
        .type = SWYP_CAP_OBJECT_MMIO,
        .object_id = 2u,
        .base = UINT64_C(0xfec00000),
        .length = UINT64_C(0x1000),
    };
    uint16_t i;

    swyp_device_graph_init(&graph);
    CHECK(swyp_device_graph_add_node(&graph, &root) == SWYP_OK);
    CHECK(swyp_device_graph_add_node(&graph, &nic) == SWYP_OK);
    for (i = 0; i < (uint16_t)(sizeof(resources) / sizeof(resources[0])); ++i) {
        CHECK(swyp_device_graph_add_resource(&graph, &resources[i]) == SWYP_OK);
    }
    CHECK(swyp_device_graph_validate(&graph) == SWYP_OK);

    swyp_capability_table_init(&table);
    swyp_driver_domain_manager_init(&manager, &table);
    swyp_driver_domain_policy_init(&policy);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(&policy, &graph, &resources[0],
                                                         SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_MAP) == SWYP_OK);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(&policy, &graph, &resources[1],
                                                         SWYP_CAP_RIGHT_BIND | SWYP_CAP_RIGHT_ACK) == SWYP_OK);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(
              &policy, &graph, &resources[2], SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE | SWYP_CAP_RIGHT_MAP) == SWYP_OK);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(&policy, &graph, &resources[3], SWYP_CAP_RIGHT_READ) == SWYP_OK);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(&policy, &graph, &resources[4], SWYP_CAP_RIGHT_CONTROL) == SWYP_OK);
    CHECK(swyp_driver_domain_open(&manager, &graph, 2u, 700u, 11u, &policy, &domain) == SWYP_OK);
    CHECK(domain != NULL && domain->domain_id == 700u && domain->node_id == 2u && domain->lease_fence == 11u);
    CHECK(domain != NULL && domain->grant_count == 5u);
    CHECK(active_capability_count(&table) == 5u);

    if (domain != NULL && domain->grant_count == 5u) {
        old_mmio = domain->grants[0];
        CHECK(swyp_driver_domain_resolve(&manager, 700u, 11u, domain->grants[0], SWYP_CAP_RIGHT_READ,
                                         SWYP_CAP_OBJECT_MMIO, &grant) == SWYP_OK);
        CHECK(grant != NULL && grant->object.base == resources[0].start && grant->rights == (SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_MAP));
        CHECK(swyp_driver_domain_resolve(&manager, 700u, 11u, domain->grants[0], SWYP_CAP_RIGHT_WRITE,
                                         SWYP_CAP_OBJECT_MMIO, &grant) == SWYP_ERR_DENIED);
        CHECK(swyp_driver_domain_resolve(&manager, 700u, 12u, domain->grants[0], SWYP_CAP_RIGHT_READ,
                                         SWYP_CAP_OBJECT_MMIO, &grant) == SWYP_ERR_DENIED);
        CHECK(swyp_driver_domain_resolve(&manager, 700u, 11u, domain->grants[1], SWYP_CAP_RIGHT_ACK,
                                         SWYP_CAP_OBJECT_INTERRUPT, &grant) == SWYP_OK);
        CHECK(swyp_driver_domain_resolve(&manager, 700u, 11u, domain->grants[3], SWYP_CAP_RIGHT_READ,
                                         SWYP_CAP_OBJECT_DEVICE_CONFIG, &grant) == SWYP_OK);
        CHECK(swyp_driver_domain_resolve(&manager, 700u, 11u, domain->grants[4], SWYP_CAP_RIGHT_CONTROL,
                                         SWYP_CAP_OBJECT_DEVICE_CONTROL, &grant) == SWYP_OK);
    }

    CHECK(swyp_capability_mint(&table, &unrelated_object, SWYP_CAP_RIGHT_READ, 700u, 11u, &unrelated) == SWYP_OK);
    CHECK(swyp_driver_domain_resolve(&manager, 700u, 11u, unrelated, SWYP_CAP_RIGHT_READ, SWYP_CAP_OBJECT_MMIO,
                                     &grant) == SWYP_ERR_DENIED);
    CHECK(swyp_driver_domain_open(&manager, &graph, 2u, 700u, 12u, &policy, &probe_domain) == SWYP_ERR_DENIED);
    CHECK(swyp_driver_domain_open(&manager, &graph, 2u, 703u, 11u, &policy, &probe_domain) == SWYP_ERR_DENIED);

    swyp_driver_domain_policy_init(&foreign_policy);
    CHECK(swyp_driver_domain_policy_allow_resource(&foreign_policy, 5u, SWYP_CAP_RIGHT_READ) == SWYP_OK);
    CHECK(swyp_driver_domain_open(&manager, &graph, 2u, 701u, 11u, &foreign_policy, &probe_domain) == SWYP_ERR_DENIED);

    swyp_driver_domain_policy_init(&excessive_policy);
    CHECK(swyp_driver_domain_policy_allow_resource(&excessive_policy, 1u, SWYP_CAP_RIGHT_READ) == SWYP_OK);
    CHECK(swyp_driver_domain_open(&manager, &graph, 2u, 702u, 11u, &excessive_policy, &probe_domain) == SWYP_ERR_DENIED);

    CHECK(swyp_driver_domain_revoke(&manager, 700u, 12u) == SWYP_ERR_DENIED);
    CHECK(swyp_driver_domain_quiesce(&manager, 700u, 12u) == SWYP_ERR_DENIED);
    CHECK(swyp_driver_domain_quiesce(&manager, 700u, 11u) == SWYP_OK);
    CHECK(domain != NULL && domain->active == SWYP_DRIVER_DOMAIN_QUIESCED);
    CHECK(swyp_driver_domain_resolve(&manager, 700u, 11u, old_mmio, SWYP_CAP_RIGHT_READ, SWYP_CAP_OBJECT_MMIO,
                                     &grant) == SWYP_ERR_DENIED);
    CHECK(swyp_driver_domain_quiesce(&manager, 700u, 11u) == SWYP_OK);
    CHECK(swyp_driver_domain_revoke(&manager, 700u, 11u) == SWYP_OK);
    CHECK(active_capability_count(&table) == 1u);
    CHECK(swyp_capability_lookup(&table, old_mmio, 700u, 11u, SWYP_CAP_RIGHT_READ, &grant) == SWYP_ERR_STALE);
    CHECK(swyp_driver_domain_resolve(&manager, 700u, 11u, old_mmio, SWYP_CAP_RIGHT_READ, SWYP_CAP_OBJECT_MMIO,
                                     &grant) == SWYP_ERR_NOT_FOUND);
    CHECK(swyp_driver_domain_open(&manager, &graph, 2u, 700u, 12u, &policy, &domain) == SWYP_OK);
    CHECK(domain != NULL && domain->grants[0] != old_mmio);
    CHECK(swyp_driver_domain_revoke(&manager, 700u, 12u) == SWYP_ERR_DENIED);
    CHECK(swyp_driver_domain_quiesce(&manager, 700u, 12u) == SWYP_OK);
    CHECK(swyp_driver_domain_revoke(&manager, 700u, 12u) == SWYP_OK);
    CHECK(swyp_capability_revoke(&table, unrelated) == SWYP_OK);

    {
        SwypCapabilityTable constrained;
        SwypDriverDomainManager constrained_manager;
        SwypDriverDomainPolicy needs_three;
        SwypCapabilityObject fill = {
            .type = SWYP_CAP_OBJECT_MMIO,
            .object_id = 99u,
            .base = UINT64_C(0x100000),
            .length = UINT64_C(0x1000),
        };
        SwypCapabilityHandle handles[SWYP_CAPABILITY_TABLE_CAPACITY - 2u];
        uint32_t fill_index;
        swyp_capability_table_init(&constrained);
        for (fill_index = 0; fill_index < SWYP_CAPABILITY_TABLE_CAPACITY - 2u; ++fill_index) {
            CHECK(swyp_capability_mint(&constrained, &fill, SWYP_CAP_RIGHT_READ, 900u + fill_index, 1u,
                                       &handles[fill_index]) == SWYP_OK);
        }
        swyp_driver_domain_manager_init(&constrained_manager, &constrained);
        swyp_driver_domain_policy_init(&needs_three);
        CHECK(swyp_driver_domain_policy_allow_resource(&needs_three, 0u, SWYP_CAP_RIGHT_READ) == SWYP_OK);
        CHECK(swyp_driver_domain_policy_allow_resource(&needs_three, 1u, SWYP_CAP_RIGHT_BIND) == SWYP_OK);
        CHECK(swyp_driver_domain_policy_allow_resource(&needs_three, 2u, SWYP_CAP_RIGHT_READ) == SWYP_OK);
        CHECK(active_capability_count(&constrained) == SWYP_CAPABILITY_TABLE_CAPACITY - 2u);
        CHECK(swyp_driver_domain_open(&constrained_manager, &graph, 2u, 800u, 1u, &needs_three, &domain) ==
              SWYP_ERR_NO_SPACE);
        CHECK(active_capability_count(&constrained) == SWYP_CAPABILITY_TABLE_CAPACITY - 2u);
    }
}

static void test_ipc(void) {
    SwypIpcEndpoint endpoint;
    SwypCapabilityTable table;
    SwypCapabilityObject endpoint_object = {
        .type = SWYP_CAP_OBJECT_IPC_ENDPOINT,
        .object_id = 99u,
    };
    SwypCapabilityObject wrong_endpoint_object = {
        .type = SWYP_CAP_OBJECT_IPC_ENDPOINT,
        .object_id = 100u,
    };
    SwypIpcMessage message = {0};
    SwypIpcMessage received = {0};
    SwypCapabilityHandle sender = 0u;
    SwypCapabilityHandle receiver = 0u;
    SwypCapabilityHandle wrong_endpoint = 0u;
    SwypCapabilityHandle revoked = 0u;
    SwypCapabilityHandle forged = (UINT64_C(1) << 32) | UINT64_C(64);
    uint32_t i;

    swyp_ipc_endpoint_init(&endpoint, 99u);
    swyp_capability_table_init(&table);
    CHECK(swyp_capability_mint(&table, &endpoint_object, SWYP_CAP_RIGHT_SEND, 7u, 11u, &sender) == SWYP_OK);
    CHECK(swyp_capability_mint(&table, &endpoint_object, SWYP_CAP_RIGHT_RECEIVE, 8u, 12u, &receiver) == SWYP_OK);
    CHECK(swyp_capability_mint(&table, &wrong_endpoint_object, SWYP_CAP_RIGHT_SEND, 7u, 11u, &wrong_endpoint) == SWYP_OK);
    CHECK(swyp_capability_mint(&table, &endpoint_object, SWYP_CAP_RIGHT_SEND, 7u, 11u, &revoked) == SWYP_OK);
    CHECK(swyp_capability_revoke(&table, revoked) == SWYP_OK);
    message.message_type = 3u;
    message.payload_size = 4u;
    message.correlation_id = 123u;
    message.payload[0] = 0xde;
    message.payload[1] = 0xad;
    message.payload[2] = 0xbe;
    message.payload[3] = 0xef;
    message.sender_capability = forged;
    CHECK(swyp_ipc_send(&endpoint, &table, sender, 8u, 11u, &message) == SWYP_ERR_DENIED);
    CHECK(swyp_ipc_send(&endpoint, &table, sender, 7u, 12u, &message) == SWYP_ERR_DENIED);
    CHECK(swyp_ipc_send(&endpoint, &table, receiver, 8u, 12u, &message) == SWYP_ERR_DENIED);
    CHECK(swyp_ipc_send(&endpoint, &table, revoked, 7u, 11u, &message) == SWYP_ERR_STALE);
    CHECK(swyp_ipc_send(&endpoint, &table, forged, 7u, 11u, &message) == SWYP_ERR_STALE);
    CHECK(swyp_ipc_send(&endpoint, &table, wrong_endpoint, 7u, 11u, &message) == SWYP_ERR_DENIED);
    CHECK(swyp_ipc_send(&endpoint, &table, sender, 7u, 11u, &message) == SWYP_OK);
    CHECK(swyp_ipc_receive(&endpoint, &table, receiver, 8u, 12u, &received) == SWYP_OK);
    CHECK(received.correlation_id == message.correlation_id);
    CHECK(received.sender_capability == sender);
    CHECK(memcmp(received.payload, message.payload, message.payload_size) == 0);
    CHECK(swyp_ipc_receive(&endpoint, &table, receiver, 8u, 12u, &received) == SWYP_ERR_NOT_FOUND);

    for (i = 0; i < SWYP_IPC_QUEUE_CAPACITY; ++i) {
        message.correlation_id = i;
        CHECK(swyp_ipc_send(&endpoint, &table, sender, 7u, 11u, &message) == SWYP_OK);
    }
    CHECK(swyp_ipc_send(&endpoint, &table, sender, 7u, 11u, &message) == SWYP_ERR_NO_SPACE);
}

static void test_device_graph_adversarial(void) {
    SwypDeviceGraph graph;
    SwypDeviceGraph decoded;
    SwypDeviceNode root = {
        .id = 1u,
        .device_class = SWYP_DEVICE_CLASS_PLATFORM,
        .bus = SWYP_DEVICE_BUS_PLATFORM,
    };
    SwypDeviceNode child = {
        .id = 2u,
        .parent_id = 1u,
        .device_class = SWYP_DEVICE_CLASS_NETWORK,
        .bus = SWYP_DEVICE_BUS_PCI,
    };
    SwypDeviceResource range = {
        .node_id = 2u,
        .kind = SWYP_DEVICE_RESOURCE_MMIO,
        .start = UINT64_C(0x1000),
        .length = UINT64_C(0x100),
    };
    SwypDeviceResource invalid;
    SwypDeviceEdge edge = {
        .from_node_id = 1u,
        .to_node_id = 2u,
        .kind = SWYP_DEVICE_EDGE_CONTAINS,
    };
    SwypCapabilityObject object;
    uint64_t rights = 0u;
    uint8_t wire[512];
    uint8_t pristine[512];
    size_t wire_size = 0u;
    size_t node0;
    size_t resource0;
    size_t edge0;

    swyp_device_graph_init(&graph);
    CHECK(swyp_device_graph_add_node(&graph, &root) == SWYP_OK);
    CHECK(swyp_device_graph_add_node(&graph, &child) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&graph, &range) == SWYP_OK);
    CHECK(swyp_device_graph_add_edge(&graph, &edge) == SWYP_OK);
    CHECK(swyp_device_graph_encode(&graph, wire, sizeof(wire), &wire_size) == SWYP_OK);
    memcpy(pristine, wire, wire_size);
    node0 = SWYP_DEVICE_GRAPH_WIRE_HEADER_BYTES;
    resource0 = node0 + 2u * SWYP_DEVICE_GRAPH_WIRE_NODE_BYTES;
    edge0 = resource0 + SWYP_DEVICE_GRAPH_WIRE_RESOURCE_BYTES;

    memset(wire + node0 + 56u, 'F', 16u);
    CHECK(swyp_device_graph_decode(&decoded, wire, wire_size) == SWYP_ERR_CORRUPT);
    memcpy(wire, pristine, wire_size);
    memset(wire + node0 + 72u, 'M', 24u);
    CHECK(swyp_device_graph_decode(&decoded, wire, wire_size) == SWYP_ERR_CORRUPT);

    memcpy(wire, pristine, wire_size);
    wire[18] = 1u;
    CHECK(swyp_device_graph_decode(&decoded, wire, wire_size) == SWYP_ERR_CORRUPT);
    memcpy(wire, pristine, wire_size);
    wire[node0 + 38u] = 1u;
    CHECK(swyp_device_graph_decode(&decoded, wire, wire_size) == SWYP_ERR_CORRUPT);
    memcpy(wire, pristine, wire_size);
    wire[node0 + 44u] = 1u;
    CHECK(swyp_device_graph_decode(&decoded, wire, wire_size) == SWYP_ERR_CORRUPT);
    memcpy(wire, pristine, wire_size);
    wire[resource0 + 12u] = 1u;
    CHECK(swyp_device_graph_decode(&decoded, wire, wire_size) == SWYP_ERR_CORRUPT);
    memcpy(wire, pristine, wire_size);
    wire[edge0 + 20u] = 1u;
    CHECK(swyp_device_graph_decode(&decoded, wire, wire_size) == SWYP_ERR_CORRUPT);

    memcpy(wire, pristine, wire_size);
    memset(wire + resource0 + 24u, 0, 8u);
    CHECK(swyp_device_graph_decode(&decoded, wire, wire_size) == SWYP_ERR_CORRUPT);
    memcpy(wire, pristine, wire_size);
    wire[resource0 + 16u] = 0xf8u;
    memset(wire + resource0 + 17u, 0xff, 7u);
    wire[resource0 + 24u] = 0x10u;
    memset(wire + resource0 + 25u, 0, 7u);
    CHECK(swyp_device_graph_decode(&decoded, wire, wire_size) == SWYP_ERR_CORRUPT);

    invalid = range;
    invalid.length = 0u;
    CHECK(swyp_device_graph_add_resource(&graph, &invalid) == SWYP_ERR_INVALID);
    CHECK(swyp_device_resource_capability(&invalid, &object, &rights) == SWYP_ERR_INVALID);
    invalid = range;
    invalid.start = UINT64_MAX - 7u;
    invalid.length = 16u;
    CHECK(swyp_device_graph_add_resource(&graph, &invalid) == SWYP_ERR_INVALID);
    CHECK(swyp_device_resource_capability(&invalid, &object, &rights) == SWYP_ERR_INVALID);
    invalid = range;
    invalid.kind = SWYP_DEVICE_RESOURCE_IRQ;
    invalid.start = 17u;
    invalid.length = 2u;
    CHECK(swyp_device_graph_add_resource(&graph, &invalid) == SWYP_ERR_INVALID);
    invalid.kind = SWYP_DEVICE_RESOURCE_CONFIG;
    invalid.start = 4095u;
    invalid.length = 2u;
    CHECK(swyp_device_graph_add_resource(&graph, &invalid) == SWYP_ERR_INVALID);
    invalid.kind = SWYP_DEVICE_RESOURCE_CLOCK_RESET_POWER;
    invalid.start = 3u;
    invalid.length = 2u;
    CHECK(swyp_device_graph_add_resource(&graph, &invalid) == SWYP_ERR_INVALID);
    invalid = range;
    invalid.kind = SWYP_DEVICE_RESOURCE_DMA;
    invalid.start = UINT64_C(0x20000001);
    invalid.length = UINT64_C(0x1000);
    CHECK(swyp_device_graph_add_resource(&graph, &invalid) == SWYP_ERR_INVALID);
    invalid.kind = SWYP_DEVICE_RESOURCE_SHARED_MEMORY;
    invalid.start = UINT64_C(0x30000000);
    invalid.length = UINT64_C(0x1800);
    CHECK(swyp_device_graph_add_resource(&graph, &invalid) == SWYP_ERR_INVALID);
    invalid = range;
    invalid.start = UINT64_C(0x1080);
    invalid.length = UINT64_C(0x40);
    CHECK(swyp_device_graph_add_resource(&graph, &invalid) == SWYP_ERR_INVALID);

    {
        SwypDeviceGraph topology;
        SwypDeviceNode a = root;
        SwypDeviceNode b = child;
        SwypDeviceEdge ab = edge;
        SwypDeviceEdge ba = {
            .from_node_id = 2u,
            .to_node_id = 1u,
            .kind = SWYP_DEVICE_EDGE_CONTAINS,
        };
        SwypDeviceEdge self = {
            .from_node_id = 1u,
            .to_node_id = 1u,
            .kind = SWYP_DEVICE_EDGE_DEPENDS_ON,
        };
        swyp_device_graph_init(&topology);
        a.parent_id = 0u;
        b.parent_id = 1u;
        CHECK(swyp_device_graph_add_node(&topology, &a) == SWYP_OK);
        CHECK(swyp_device_graph_add_node(&topology, &b) == SWYP_OK);
        CHECK(swyp_device_graph_add_edge(&topology, &ab) == SWYP_OK);
        CHECK(swyp_device_graph_add_edge(&topology, &ab) == SWYP_ERR_INVALID);
        CHECK(swyp_device_graph_add_edge(&topology, &self) == SWYP_ERR_INVALID);
        CHECK(swyp_device_graph_add_edge(&topology, &ba) == SWYP_ERR_INVALID);
        topology.nodes[0].parent_id = 2u;
        CHECK(swyp_device_graph_validate(&topology) == SWYP_ERR_CORRUPT);
        topology.nodes[0].parent_id = 1u;
        CHECK(swyp_device_graph_validate(&topology) == SWYP_ERR_CORRUPT);
    }
}

static void test_device_graph_wire(void) {
    SwypDeviceGraph graph;
    SwypDeviceGraph decoded;
    SwypDeviceNode root = {
        .id = 1u,
        .device_class = SWYP_DEVICE_CLASS_PLATFORM,
        .bus = SWYP_DEVICE_BUS_PLATFORM,
    };
    SwypDeviceNode nic = {
        .id = 2u,
        .parent_id = 1u,
        .device_class = SWYP_DEVICE_CLASS_NETWORK,
        .bus = SWYP_DEVICE_BUS_PCI,
        .vendor_id = 0x1af4u,
        .device_id = 0x1000u,
        .class_code = 0x02u,
        .subclass = 0x00u,
        .prog_if = 0u,
        .revision = 1u,
        .iommu_group = 4u,
        .feature_bits = UINT64_C(0x5),
    };
    SwypDeviceResource mmio = {
        .node_id = 2u,
        .kind = SWYP_DEVICE_RESOURCE_MMIO,
        .start = UINT64_C(0xfebf0000),
        .length = UINT64_C(0x1000),
    };
    SwypDeviceResource irq = {
        .node_id = 2u,
        .kind = SWYP_DEVICE_RESOURCE_IRQ,
        .start = 17u,
        .length = 1u,
    };
    SwypDeviceEdge contains = {
        .from_node_id = 1u,
        .to_node_id = 2u,
        .kind = SWYP_DEVICE_EDGE_CONTAINS,
    };
    SwypCapabilityObject capability_object;
    uint64_t rights = 0u;
    uint8_t wire[1024];
    size_t wire_size = 0u;

    memcpy(nic.firmware_version, "virtio-1", 9u);
    memcpy(nic.model, "virtio-net", 11u);
    swyp_device_graph_init(&graph);
    CHECK(swyp_device_graph_add_node(&graph, &root) == SWYP_OK);
    CHECK(swyp_device_graph_add_node(&graph, &nic) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&graph, &mmio) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&graph, &irq) == SWYP_OK);
    CHECK(swyp_device_graph_add_edge(&graph, &contains) == SWYP_OK);
    CHECK(swyp_device_graph_validate(&graph) == SWYP_OK);
    CHECK(swyp_device_graph_encode(&graph, wire, sizeof(wire), &wire_size) == SWYP_OK);
    CHECK(wire_size == SWYP_DEVICE_GRAPH_WIRE_HEADER_BYTES + 2u * SWYP_DEVICE_GRAPH_WIRE_NODE_BYTES +
                           2u * SWYP_DEVICE_GRAPH_WIRE_RESOURCE_BYTES + SWYP_DEVICE_GRAPH_WIRE_EDGE_BYTES);
    CHECK(swyp_device_graph_decode(&decoded, wire, wire_size) == SWYP_OK);
    CHECK(decoded.node_count == 2u && decoded.resource_count == 2u && decoded.edge_count == 1u);
    CHECK(decoded.nodes[1].vendor_id == nic.vendor_id);
    CHECK(strcmp(decoded.nodes[1].model, "virtio-net") == 0);
    CHECK(swyp_device_resource_capability(&decoded.resources[0], &capability_object, &rights) == SWYP_OK);
    CHECK(capability_object.type == SWYP_CAP_OBJECT_MMIO);
    CHECK((rights & (SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE | SWYP_CAP_RIGHT_MAP)) != 0u);

    wire[0] ^= 0xffu;
    CHECK(swyp_device_graph_decode(&decoded, wire, wire_size) == SWYP_ERR_CORRUPT);
}

static void test_kernel_runtime_driver_domain_lifecycle(void) {
    uint8_t image[0x200];
    FakeX86PagePool pool = {0};
    FakeX86Hardware hardware = {.pool = &pool};
    SwypPageAllocator allocator = {.context = &pool, .ops = &fake_x86_allocator_ops};
    FakePlatformRuntime interrupt_runtime = {0};
    SwypKernelRuntime runtime;
    SwypX86KernelRoot kernel_root;
    SwypDeviceGraph graph;
    SwypDeviceNode nic = {
        .id = 2u,
        .device_class = SWYP_DEVICE_CLASS_NETWORK,
        .bus = SWYP_DEVICE_BUS_PCI,
    };
    SwypDeviceResource mmio = {
        .node_id = 2u,
        .kind = SWYP_DEVICE_RESOURCE_MMIO,
        .start = UINT64_C(0xfebf0000),
        .length = UINT64_C(0x2000),
    };
    SwypDeviceResource irq = {
        .node_id = 2u,
        .kind = SWYP_DEVICE_RESOURCE_IRQ,
        .start = 17u,
        .length = 1u,
    };
    SwypDriverDomainPolicy policy;
    const SwypDriverDomain *domain = NULL;
    const SwypCapabilityGrant *stale_grant = NULL;
    SwypAddressSpace *address_space = NULL;
    SwypDeviceBroker *broker;
    SwypDeviceMapping mapping;
    SwypDeviceIrqBinding irq_binding;
    SwypX86AddressSpace *x86_space;
    SwypScheduler *scheduler;
    SwypThreadContext kernel_context = {0};
    SwypThreadContext driver_context = {0};
    SwypX86_64ThreadContext *driver_x86_context;
    SwypX86UserLaunch launch;
    SwypX86PrivilegeState syscall_privilege;
    FakeApicHardware timer_hardware = {0};
    SwypX86LapicTimer timer;
    FakeExtendedStateHardware extended_hardware = {0};
    uint64_t trap_storage[(sizeof(SwypX86TrapFrame) / sizeof(uint64_t)) + 2u] = {0};
    SwypX86TrapFrame *user_trap = (SwypX86TrapFrame *)(void *)trap_storage;
    uint64_t *user_tail = (uint64_t *)(void *)(user_trap + 1);
    SwypCapabilityHandle old_handle = 0u;
    uint64_t physical = 0u;
    uint64_t flags = 0u;
    uint64_t thread_id = 0u;
    uint64_t kernel_identity = UINT64_C(0x200000);
    volatile int64_t yield_reason = 0;
    volatile int64_t preempt_reason = 0;
    volatile int64_t exit_reason = 0;

    interrupt_runtime.interrupts.context = &interrupt_runtime;
    interrupt_runtime.interrupts.ops = &fake_platform_interrupt_ops;
    build_test_driver_image(image, sizeof(image));
    swyp_device_graph_init(&graph);
    CHECK(swyp_device_graph_add_node(&graph, &nic) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&graph, &mmio) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&graph, &irq) == SWYP_OK);
    swyp_driver_domain_policy_init(&policy);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(&policy, &graph, &mmio,
                                                         SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_MAP) == SWYP_OK);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(&policy, &graph, &irq,
                                                         SWYP_CAP_RIGHT_BIND | SWYP_CAP_RIGHT_ACK) == SWYP_OK);

    CHECK(swyp_x86_64_kernel_root_init(&kernel_root, &allocator, &hardware, &fake_x86_hardware_ops,
                                       SWYP_X86_64_DIRECT_MAP_BASE, UINT64_C(0x40000000)) == SWYP_OK);
    CHECK(swyp_x86_64_kernel_root_map_identity(&kernel_root, kernel_identity, SWYP_X86_64_PAGE_SIZE,
                                               SWYP_MMU_READ | SWYP_MMU_EXECUTE | SWYP_MMU_GLOBAL, 0) == SWYP_OK);
    CHECK(swyp_x86_64_kernel_root_activate(&kernel_root) == SWYP_OK);
    CHECK(swyp_kernel_runtime_init(&runtime, &allocator, &hardware, &fake_x86_hardware_ops,
                                   &interrupt_runtime.interrupts, NULL, NULL) == SWYP_OK);
    CHECK(swyp_kernel_runtime_bind_extended_state(&runtime, &extended_hardware, &fake_extended_state_ops) == SWYP_OK);
    CHECK(swyp_kernel_runtime_bind_kernel_root(&runtime, &kernel_root) == SWYP_OK);
    CHECK(swyp_kernel_runtime_open_driver_domain(&runtime, &graph, 2u, 700u, 11u, &policy, &domain,
                                                 &address_space) == SWYP_OK);
    CHECK(domain != NULL && address_space != NULL && domain->domain_id == 700u && domain->lease_fence == 11u);
    old_handle = domain->grants[0];

    CHECK(swyp_kernel_runtime_load_driver_image(&runtime, 700u, 11u, image, sizeof(image), 2u,
                                                &driver_context) == SWYP_OK);
    CHECK(swyp_kernel_runtime_load_driver_image(&runtime, 700u, 11u, image, sizeof(image), 2u,
                                                &driver_context) == SWYP_ERR_DENIED);
    driver_x86_context = (SwypX86_64ThreadContext *)(void *)driver_context.storage;
    CHECK(driver_context.used_bytes == sizeof(SwypX86_64ThreadContext) &&
          driver_x86_context->rip == SWYP_X86_DRIVER_IMAGE_BASE + UINT64_C(0x100) &&
          driver_x86_context->rsp == SWYP_X86_DRIVER_STACK_TOP);

    kernel_context.abi_version = SWYP_KERNEL_ABI_VERSION;
    kernel_context.struct_size = (uint32_t)sizeof(kernel_context);
    kernel_context.arch = SWYP_ARCH_X86_64;
    scheduler = swyp_kernel_runtime_scheduler(&runtime);
    CHECK(scheduler != NULL);
    CHECK(swyp_scheduler_add_thread(scheduler, 1u, SWYP_SCHEDULER_THREAD_KERNEL, 0u, 0u, &kernel_context) == SWYP_OK);
    CHECK(swyp_scheduler_add_thread(scheduler, 2u, SWYP_SCHEDULER_THREAD_DRIVER, 700u, 11u,
                                    &driver_context) == SWYP_OK);
    CHECK(swyp_scheduler_dispatch(scheduler, &thread_id) == SWYP_OK && thread_id == 1u);
    CHECK(swyp_scheduler_dispatch(scheduler, &thread_id) == SWYP_OK && thread_id == 2u);
    CHECK(swyp_kernel_runtime_restore_current_driver_extended_state(&runtime) == SWYP_OK);
    CHECK(extended_hardware.restores == 1u);
    CHECK(extended_hardware.last_restored_fx.bytes[0] == UINT8_C(0x7f) &&
          extended_hardware.last_restored_fx.bytes[1] == UINT8_C(0x03) &&
          extended_hardware.last_restored_fx.bytes[24] == UINT8_C(0x80) &&
          extended_hardware.last_restored_fx.bytes[25] == UINT8_C(0x1f));

    CHECK(swyp_kernel_runtime_prepare_current_driver_launch(&runtime, &launch) == SWYP_OK);
    CHECK(launch.code_selector == SWYP_X86_SELECTOR_USER_CODE && launch.data_selector == SWYP_X86_SELECTOR_USER_DATA);
    CHECK(launch.context.rip == driver_x86_context->rip && launch.context.rsp == driver_x86_context->rsp);
    CHECK((launch.context.rflags & SWYP_X86_RFLAGS_FIXED) != 0u);
    CHECK((launch.context.rflags & SWYP_X86_RFLAGS_IF) == 0u);
    CHECK((launch.context.rflags & (SWYP_X86_RFLAGS_IOPL_MASK | SWYP_X86_RFLAGS_NT | SWYP_X86_RFLAGS_VM)) == 0u);

    CHECK(swyp_x86_privilege_init(&syscall_privilege, UINT64_C(0x700000)) == SWYP_OK);
    CHECK(swyp_kernel_runtime_bind_syscall_idt(&runtime, &syscall_privilege) == SWYP_OK);
    CHECK(swyp_x86_privilege_idt_handler(&syscall_privilege, SWYP_X86_SYSCALL_VECTOR) ==
          (uint64_t)(uintptr_t)&swyp_x86_syscall_entry);
    CHECK((syscall_privilege.idt[SWYP_X86_SYSCALL_VECTOR].type_attributes & UINT8_C(0x60)) == UINT8_C(0x60));
    CHECK(syscall_privilege.idt[SWYP_X86_SYSCALL_VECTOR].selector == SWYP_X86_SELECTOR_KERNEL_CODE);
    CHECK(swyp_x86_privilege_idt_handler(&syscall_privilege, SWYP_X86_IRQ_VECTOR_FIRST) != 0u);
    CHECK(swyp_x86_privilege_idt_handler(&syscall_privilege, SWYP_X86_SYSCALL_VECTOR) !=
          swyp_x86_privilege_idt_handler(&syscall_privilege, SWYP_X86_IRQ_VECTOR_FIRST));
    CHECK(swyp_x86_lapic_timer_init(&timer, &timer_hardware, &fake_timer_hardware_ops, 1000u, 3u, NULL, NULL) ==
          SWYP_OK);
    CHECK(swyp_kernel_runtime_bind_preemption_timer(&runtime, &timer, &syscall_privilege) == SWYP_OK);
    CHECK(swyp_x86_privilege_idt_handler(&syscall_privilege, SWYP_X86_TIMER_VECTOR) ==
          (uint64_t)(uintptr_t)&swyp_x86_lapic_timer_entry);
    CHECK(swyp_scheduler_set_thread_quantum(scheduler, 2u, 2u) == SWYP_OK);

    user_trap->rip = driver_x86_context->rip;
    user_trap->cs = SWYP_X86_SELECTOR_USER_CODE;
    user_trap->rflags = SWYP_X86_RFLAGS_FIXED;
    user_trap->vector = SWYP_X86_SYSCALL_VECTOR;
    user_trap->error_code = 0u;
    user_tail[0] = SWYP_X86_DRIVER_STACK_TOP;
    user_tail[1] = SWYP_X86_SELECTOR_USER_DATA;
    user_trap->rax = SWYP_X86_SYSCALL_ABI_VERSION;
    swyp_x86_syscall_dispatch(user_trap);
    CHECK(user_trap->rax == SWYP_KERNEL_ABI_VERSION);
    user_trap->rax = SWYP_X86_SYSCALL_THREAD_ID;
    swyp_x86_syscall_dispatch(user_trap);
    CHECK(user_trap->rax == 2u);
    user_trap->rax = SWYP_X86_SYSCALL_DOMAIN_ID;
    swyp_x86_syscall_dispatch(user_trap);
    CHECK(user_trap->rax == 700u);
    user_trap->rax = SWYP_X86_SYSCALL_LEASE_FENCE;
    swyp_x86_syscall_dispatch(user_trap);
    CHECK(user_trap->rax == 11u);
    user_trap->rax = UINT64_C(0xffff);
    swyp_x86_syscall_dispatch(user_trap);
    CHECK((int64_t)user_trap->rax == SWYP_ERR_UNSUPPORTED);

    user_trap->rax = UINT64_C(0x11);
    user_trap->rbx = UINT64_C(0x22);
    user_trap->rcx = UINT64_C(0x33);
    user_trap->rdx = UINT64_C(0x44);
    user_trap->r8 = UINT64_C(0x88);
    user_trap->r15 = UINT64_C(0xff);
    user_trap->rip = driver_x86_context->rip + 1u;
    user_trap->cs = SWYP_X86_SELECTOR_USER_CODE;
    user_trap->rflags = SWYP_X86_RFLAGS_FIXED | SWYP_X86_RFLAGS_IOPL_MASK | SWYP_X86_RFLAGS_NT;
    user_tail[0] = SWYP_X86_DRIVER_STACK_TOP - UINT64_C(0x10);
    user_tail[1] = SWYP_X86_SELECTOR_USER_DATA;
    memset(&extended_hardware.hardware_fx, UINT8_C(0xa5), sizeof(extended_hardware.hardware_fx));
    extended_hardware.fs_base = UINT64_C(0x12345000);
    extended_hardware.gs_base = UINT64_C(0x56789000);
    CHECK(swyp_kernel_runtime_capture_current_driver_trap(&runtime, user_trap) == SWYP_OK);
    CHECK(extended_hardware.saves == 1u);
    CHECK(swyp_kernel_runtime_prepare_current_driver_launch(&runtime, &launch) == SWYP_OK);
    CHECK(launch.context.rax == UINT64_C(0x11) && launch.context.rbx == UINT64_C(0x22) &&
          launch.context.rcx == UINT64_C(0x33) && launch.context.rdx == UINT64_C(0x44));
    CHECK(launch.context.r8 == UINT64_C(0x88) && launch.context.r15 == UINT64_C(0xff));
    CHECK(launch.context.rip == driver_x86_context->rip + 1u &&
          launch.context.rsp == SWYP_X86_DRIVER_STACK_TOP - UINT64_C(0x10));
    CHECK((launch.context.rflags & SWYP_X86_RFLAGS_IOPL_MASK) == 0u &&
          (launch.context.rflags & SWYP_X86_RFLAGS_NT) == 0u &&
          (launch.context.rflags & SWYP_X86_RFLAGS_IF) == 0u);

    user_trap->rip = SWYP_X86_DRIVER_IMAGE_BASE - 1u;
    CHECK(swyp_kernel_runtime_capture_current_driver_trap(&runtime, user_trap) == SWYP_ERR_DENIED);
    CHECK(swyp_kernel_runtime_prepare_current_driver_launch(&runtime, &launch) == SWYP_OK);
    CHECK(launch.context.rip == driver_x86_context->rip + 1u);

    user_trap->vector = SWYP_X86_SYSCALL_VECTOR;
    user_trap->error_code = 0u;
    user_trap->rip = launch.context.rip;
    user_trap->cs = SWYP_X86_SELECTOR_USER_CODE;
    user_trap->rflags = launch.context.rflags;
    user_tail[0] = launch.context.rsp;
    user_tail[1] = SWYP_X86_SELECTOR_USER_DATA;
    yield_reason = swyp_x86_kernel_continuation_capture(&runtime.driver_continuation);
    if (yield_reason == 0) {
        runtime.driver_continuation_active = 1u;
        runtime.driver_continuation_thread_id = 2u;
        user_trap->rax = SWYP_X86_SYSCALL_YIELD;
        swyp_x86_syscall_dispatch(user_trap);
        CHECK(0 && "yield syscall unexpectedly returned");
    }
    runtime.driver_continuation_active = 0u;
    runtime.driver_continuation_thread_id = 0u;
    CHECK(yield_reason == SWYP_KERNEL_DRIVER_RUN_YIELD);
    CHECK(swyp_scheduler_current(scheduler) == NULL);
    CHECK(swyp_scheduler_thread(scheduler, 2u) != NULL &&
          swyp_scheduler_thread(scheduler, 2u)->state == SWYP_SCHEDULER_STATE_READY);
    CHECK(hardware.current_root == kernel_root.pml4_physical);
    CHECK(swyp_scheduler_dispatch(scheduler, &thread_id) == SWYP_OK && thread_id == 1u);
    CHECK(swyp_scheduler_dispatch(scheduler, &thread_id) == SWYP_OK && thread_id == 2u);
    CHECK(swyp_kernel_runtime_restore_current_driver_extended_state(&runtime) == SWYP_OK);
    CHECK(extended_hardware.restores == 2u && extended_hardware.last_restored_fx.bytes[31] == UINT8_C(0xa5));
    CHECK(extended_hardware.last_written_fs == UINT64_C(0x12345000) &&
          extended_hardware.last_written_gs == UINT64_C(0x56789000));
    CHECK(swyp_kernel_runtime_prepare_current_driver_launch(&runtime, &launch) == SWYP_OK);
    CHECK(launch.context.rax == 0u);

    /* Timer tick one consumes half the quantum and returns to the same user
       frame. Tick two captures the updated frame, rotates the driver back to
       READY, switches to kernel CR3 and resumes the launch continuation. */
    CHECK(swyp_x86_lapic_timer_arm_periodic(&timer) == SWYP_OK);
    CHECK(timer.armed != 0u && timer_hardware.lapic_writes == 4u);
    runtime.driver_continuation_active = 1u;
    runtime.driver_continuation_thread_id = 2u;
    user_trap->vector = SWYP_X86_TIMER_VECTOR;
    user_trap->error_code = 0u;
    user_trap->rip = launch.context.rip + 2u;
    user_trap->cs = SWYP_X86_SELECTOR_USER_CODE;
    user_trap->rflags = SWYP_X86_RFLAGS_FIXED | SWYP_X86_RFLAGS_IF;
    user_trap->rax = UINT64_C(0x5151);
    user_tail[0] = launch.context.rsp;
    user_tail[1] = SWYP_X86_SELECTOR_USER_DATA;
    memset(&extended_hardware.hardware_fx, UINT8_C(0x5a), sizeof(extended_hardware.hardware_fx));
    extended_hardware.fs_base = UINT64_C(0x11111000);
    extended_hardware.gs_base = UINT64_C(0x22222000);
    swyp_x86_lapic_timer_dispatch(user_trap);
    CHECK(swyp_scheduler_current(scheduler) != NULL && swyp_scheduler_current(scheduler)->id == 2u);
    CHECK(swyp_scheduler_thread(scheduler, 2u)->remaining_ticks == 1u);
    CHECK(scheduler->tick_count == 1u);
    CHECK(timer_hardware.last_lapic_offset == 0xB0u && timer_hardware.last_lapic_value == 0u);

    user_trap->rip = launch.context.rip + 3u;
    user_trap->rax = UINT64_C(0x6161);
    preempt_reason = swyp_x86_kernel_continuation_capture(&runtime.driver_continuation);
    if (preempt_reason == 0) {
        swyp_x86_lapic_timer_dispatch(user_trap);
        CHECK(0 && "timer preemption unexpectedly returned");
    }
    runtime.driver_continuation_active = 0u;
    runtime.driver_continuation_thread_id = 0u;
    CHECK(preempt_reason == SWYP_KERNEL_DRIVER_RUN_PREEMPT);
    CHECK(swyp_scheduler_current(scheduler) == NULL);
    CHECK(swyp_scheduler_thread(scheduler, 2u) != NULL &&
          swyp_scheduler_thread(scheduler, 2u)->state == SWYP_SCHEDULER_STATE_READY &&
          swyp_scheduler_thread(scheduler, 2u)->remaining_ticks == 2u);
    CHECK(scheduler->tick_count == 2u && hardware.current_root == kernel_root.pml4_physical);
    CHECK(((SwypX86_64ThreadContext *)(void *)swyp_scheduler_thread(scheduler, 2u)->context.storage)->rax ==
          UINT64_C(0x6161));
    CHECK(((SwypX86_64ThreadContext *)(void *)swyp_scheduler_thread(scheduler, 2u)->context.storage)->rip ==
          launch.context.rip + 3u);
    CHECK(swyp_x86_lapic_timer_disarm(&timer) == SWYP_OK && timer.armed == 0u);
    CHECK(swyp_scheduler_dispatch(scheduler, &thread_id) == SWYP_OK && thread_id == 1u);
    CHECK(swyp_scheduler_dispatch(scheduler, &thread_id) == SWYP_OK && thread_id == 2u);
    CHECK(swyp_kernel_runtime_restore_current_driver_extended_state(&runtime) == SWYP_OK);
    CHECK(extended_hardware.restores == 3u && extended_hardware.last_restored_fx.bytes[31] == UINT8_C(0x5a));
    CHECK(extended_hardware.last_written_fs == UINT64_C(0x11111000) &&
          extended_hardware.last_written_gs == UINT64_C(0x22222000));
    CHECK(swyp_kernel_runtime_prepare_current_driver_launch(&runtime, &launch) == SWYP_OK);
    CHECK(launch.context.rax == UINT64_C(0x6161));
    CHECK(launch.context.rip == driver_x86_context->rip + 4u);

    broker = swyp_kernel_runtime_device_broker(&runtime);
    CHECK(broker != NULL);
    CHECK(swyp_device_broker_bind_irq(broker, 700u, 11u, domain->grants[1], &irq_binding) == SWYP_OK);
    CHECK(irq_binding.handle != 0u && irq_binding.vector >= SWYP_X86_IRQ_VECTOR_FIRST &&
          irq_binding.vector <= SWYP_X86_IRQ_VECTOR_LAST && irq_binding.vector != SWYP_X86_SYSCALL_VECTOR);
    CHECK(interrupt_runtime.irq_binds == 1u && interrupt_runtime.irq_unmasks == 1u);

    user_trap->vector = irq_binding.vector;
    user_trap->error_code = 0u;
    user_trap->rip = launch.context.rip;
    user_trap->cs = SWYP_X86_SELECTOR_USER_CODE;
    user_trap->rflags = launch.context.rflags;
    user_tail[0] = launch.context.rsp;
    user_tail[1] = SWYP_X86_SELECTOR_USER_DATA;
    swyp_x86_irq_dispatch(user_trap);
    CHECK(interrupt_runtime.irq_masks == 1u);
    CHECK(interrupt_runtime.irq_eois == 0u);
    {
        uint32_t pending_vector = 0u;
        uint32_t pending_source = 0u;
        CHECK(swyp_x86_irq_next_pending(&runtime.irq_dispatcher, 700u, 11u, &pending_vector,
                                        &pending_source) == SWYP_OK);
        CHECK(pending_vector == irq_binding.vector && pending_source == 17u);
    }
    user_trap->vector = SWYP_X86_SYSCALL_VECTOR;
    user_trap->error_code = 0u;
    user_trap->rax = SWYP_X86_SYSCALL_IRQ_NEXT;
    swyp_x86_syscall_dispatch(user_trap);
    CHECK(user_trap->rax == irq_binding.handle);
    user_trap->rax = SWYP_X86_SYSCALL_IRQ_ACK;
    user_trap->rdi = irq_binding.handle;
    swyp_x86_syscall_dispatch(user_trap);
    CHECK(user_trap->rax == 0u);
    CHECK(interrupt_runtime.irq_eois == 1u && interrupt_runtime.irq_unmasks == 2u);
    {
        uint32_t pending_vector = 0u;
        uint32_t pending_source = 0u;
        CHECK(swyp_x86_irq_next_pending(&runtime.irq_dispatcher, 700u, 11u, &pending_vector,
                                        &pending_source) == SWYP_ERR_NOT_FOUND);
    }
    CHECK(swyp_device_broker_map_mmio(broker, 700u, 11u, old_handle, 0u, 0x1000u,
                                      SWYP_CAP_RIGHT_READ, &mapping) == SWYP_OK);
    CHECK(mapping.address >= SWYP_X86_DRIVER_RUNTIME_VA_BASE);
    x86_space = swyp_x86_64_driver_runtime_x86_space(&runtime.x86_driver_runtime, 700u, 11u);
    CHECK(x86_space != NULL);
    CHECK(swyp_x86_64_address_space_query(x86_space, mapping.address, &physical, &flags) == SWYP_OK);
    CHECK(physical == mmio.start);
    CHECK((flags & (SWYP_MMU_READ | SWYP_MMU_USER | SWYP_MMU_DEVICE)) ==
          (SWYP_MMU_READ | SWYP_MMU_USER | SWYP_MMU_DEVICE));
    CHECK((flags & (SWYP_MMU_WRITE | SWYP_MMU_EXECUTE | SWYP_MMU_GLOBAL)) == 0u);

    CHECK(hardware.current_root == x86_space->pml4_physical);
    user_trap->vector = SWYP_X86_SYSCALL_VECTOR;
    user_trap->error_code = 0u;
    user_trap->rip = launch.context.rip;
    user_trap->cs = SWYP_X86_SELECTOR_USER_CODE;
    user_trap->rflags = launch.context.rflags;
    user_tail[0] = launch.context.rsp;
    user_tail[1] = SWYP_X86_SELECTOR_USER_DATA;
    exit_reason = swyp_x86_kernel_continuation_capture(&runtime.driver_continuation);
    if (exit_reason == 0) {
        runtime.driver_continuation_active = 1u;
        runtime.driver_continuation_thread_id = 2u;
        user_trap->rax = SWYP_X86_SYSCALL_EXIT;
        swyp_x86_syscall_dispatch(user_trap);
        CHECK(0 && "exit syscall unexpectedly returned");
    }
    runtime.driver_continuation_active = 0u;
    runtime.driver_continuation_thread_id = 0u;
    CHECK(exit_reason == SWYP_KERNEL_DRIVER_RUN_EXIT);
    CHECK(swyp_scheduler_current(scheduler) == NULL);
    CHECK(swyp_scheduler_thread(scheduler, 2u) != NULL &&
          swyp_scheduler_thread(scheduler, 2u)->state == SWYP_SCHEDULER_STATE_STOPPED);
    CHECK(hardware.current_root == kernel_root.pml4_physical);
    CHECK(swyp_kernel_runtime_close_driver_domain(&runtime, 700u, 11u) == SWYP_OK);
    CHECK(hardware.current_root == kernel_root.pml4_physical);
    CHECK(swyp_scheduler_thread(scheduler, 2u) == NULL);
    CHECK(swyp_kernel_runtime_unload_driver_image(&runtime, 700u, 11u) == SWYP_ERR_NOT_FOUND);
    CHECK(swyp_x86_64_driver_runtime_x86_space(&runtime.x86_driver_runtime, 700u, 11u) == NULL);
    CHECK(swyp_capability_lookup(&runtime.capability_table, old_handle, 700u, 11u, SWYP_CAP_RIGHT_READ,
                                 &stale_grant) == SWYP_ERR_STALE);
    hardware.current_root = 0u;
    CHECK(swyp_x86_64_kernel_root_destroy(&kernel_root) == SWYP_OK);
    CHECK(fake_x86_used_pages(&pool) == 0u);
}

static void test_kernel_runtime_vtd_auto_attach_and_dma(void) {
    FakeX86PagePool pool = {0};
    FakeX86Hardware hardware = {.pool = &pool};
    SwypPageAllocator allocator = {.context = &pool, .ops = &fake_x86_allocator_ops};
    FakePlatformRuntime interrupt_runtime = {0};
    FakeVtdRegisters registers = {
        .capability = (UINT64_C(1) << 10) | UINT64_C(1),
        .extended_capability = UINT64_C(1) | (TEST_VTD_IRO << 8),
    };
    SwypX86Vtd vtd;
    SwypX86Iommu iommu;
    SwypKernelRuntime runtime;
    SwypDeviceGraph graph;
    SwypDeviceGraph missing_config_graph;
    SwypDeviceNode nic = {
        .id = 2u,
        .device_class = SWYP_DEVICE_CLASS_NETWORK,
        .bus = SWYP_DEVICE_BUS_PCI,
    };
    SwypDeviceResource dma = {
        .node_id = 2u,
        .kind = SWYP_DEVICE_RESOURCE_DMA,
        .start = UINT64_C(0x20000000),
        .length = UINT64_C(0x4000),
    };
    SwypDeviceResource shared = {
        .node_id = 2u,
        .kind = SWYP_DEVICE_RESOURCE_SHARED_MEMORY,
        .start = UINT64_C(0x30000000),
        .length = UINT64_C(0x4000),
    };
    SwypDeviceResource config = {
        .node_id = 2u,
        .kind = SWYP_DEVICE_RESOURCE_CONFIG,
        .start = 0u,
        .length = UINT64_C(0x100),
    };
    SwypDriverDomainPolicy policy;
    SwypDriverDomainPolicy missing_config_policy;
    const SwypDriverDomain *domain = NULL;
    SwypAddressSpace *address_space = NULL;
    SwypCapabilityHandle dma_handle = 0u;
    SwypCapabilityHandle shared_handle = 0u;
    SwypDeviceMapping dma_mapping;
    uint64_t mapped_physical = 0u;
    uint64_t mapped_rights = 0u;
    uint64_t requester = swyp_x86_pci_config_aux(0u, 2u, 3u, 1u);
    uint32_t pages_before_invalid_open;
    uint16_t i;

    interrupt_runtime.interrupts.context = &interrupt_runtime;
    interrupt_runtime.interrupts.ops = &fake_platform_interrupt_ops;
    config.aux = requester;

    CHECK(swyp_x86_vtd_init(&vtd, 0u, &allocator, &hardware, &fake_x86_hardware_ops, &registers,
                            &fake_vtd_register_ops) == SWYP_OK);
    swyp_x86_iommu_init(&iommu, &vtd, swyp_x86_vtd_iommu_ops());
    CHECK(swyp_kernel_runtime_init(&runtime, &allocator, &hardware, &fake_x86_hardware_ops,
                                   &interrupt_runtime.interrupts, &iommu, NULL) == SWYP_OK);

    swyp_device_graph_init(&missing_config_graph);
    CHECK(swyp_device_graph_add_node(&missing_config_graph, &nic) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&missing_config_graph, &dma) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&missing_config_graph, &shared) == SWYP_OK);
    swyp_driver_domain_policy_init(&missing_config_policy);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(
              &missing_config_policy, &missing_config_graph, &dma,
              SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE | SWYP_CAP_RIGHT_MAP) == SWYP_OK);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(
              &missing_config_policy, &missing_config_graph, &shared,
              SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE | SWYP_CAP_RIGHT_MAP) == SWYP_OK);
    pages_before_invalid_open = fake_x86_used_pages(&pool);
    CHECK(swyp_kernel_runtime_open_driver_domain(&runtime, &missing_config_graph, 2u, 699u, 10u,
                                                 &missing_config_policy, &domain, &address_space) == SWYP_ERR_CORRUPT);
    CHECK(domain == NULL && address_space == NULL);
    CHECK(swyp_x86_64_driver_runtime_x86_space(&runtime.x86_driver_runtime, 699u, 10u) == NULL);
    CHECK(!swyp_x86_iommu_domain_has_devices(&iommu, 699u, 10u));
    CHECK(fake_x86_used_pages(&pool) == pages_before_invalid_open);

    swyp_device_graph_init(&graph);
    CHECK(swyp_device_graph_add_node(&graph, &nic) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&graph, &dma) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&graph, &shared) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&graph, &config) == SWYP_OK);
    swyp_driver_domain_policy_init(&policy);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(
              &policy, &graph, &dma, SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE | SWYP_CAP_RIGHT_MAP) == SWYP_OK);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(
              &policy, &graph, &shared, SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE | SWYP_CAP_RIGHT_MAP) == SWYP_OK);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(&policy, &graph, &config, SWYP_CAP_RIGHT_READ) == SWYP_OK);

    CHECK(swyp_kernel_runtime_open_driver_domain(&runtime, &graph, 2u, 700u, 11u, &policy, &domain,
                                                 &address_space) == SWYP_OK);
    CHECK(domain != NULL && address_space != NULL);
    CHECK(swyp_x86_iommu_domain_has_devices(&iommu, 700u, 11u));
    CHECK(test_vtd_domain(&vtd, 700u) != NULL);
    for (i = 0u; i < domain->grant_count; ++i) {
        const SwypCapabilityGrant *grant = NULL;
        CHECK(swyp_capability_lookup(&runtime.capability_table, domain->grants[i], 700u, 11u,
                                     SWYP_CAP_RIGHT_READ, &grant) == SWYP_OK);
        if (grant != NULL && grant->object.type == SWYP_CAP_OBJECT_DMA) {
            dma_handle = domain->grants[i];
        } else if (grant != NULL && grant->object.type == SWYP_CAP_OBJECT_SHARED_MEMORY) {
            shared_handle = domain->grants[i];
        }
    }
    CHECK(dma_handle != 0u && shared_handle != 0u);
    CHECK(swyp_device_broker_map_dma(&runtime.device_broker, 700u, 11u, dma_handle, shared_handle, 0u,
                                     UINT64_C(0x2000), SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE,
                                     &dma_mapping) == SWYP_OK);
    CHECK(dma_mapping.address == dma.start && dma_mapping.length == UINT64_C(0x2000));
    CHECK(swyp_x86_iommu_domain_has_mappings(&iommu, 700u, 11u));
    CHECK(swyp_x86_vtd_query(&vtd, 700u, dma_mapping.address + UINT64_C(0x321), &mapped_physical,
                             &mapped_rights) == SWYP_OK);
    CHECK(mapped_physical == shared.start + UINT64_C(0x321));
    CHECK(mapped_rights == (SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE));

    CHECK(swyp_kernel_runtime_close_driver_domain(&runtime, 700u, 11u) == SWYP_OK);
    CHECK(!swyp_x86_iommu_domain_has_mappings(&iommu, 700u, 11u));
    CHECK(!swyp_x86_iommu_domain_has_devices(&iommu, 700u, 11u));
    CHECK(test_vtd_domain(&vtd, 700u) == NULL);
    CHECK(swyp_x86_64_driver_runtime_x86_space(&runtime.x86_driver_runtime, 700u, 11u) == NULL);
    CHECK(swyp_x86_vtd_query(&vtd, 700u, dma.start, &mapped_physical, &mapped_rights) == SWYP_ERR_NOT_FOUND);
    CHECK(swyp_x86_vtd_shutdown(&vtd) == SWYP_OK);
    CHECK(fake_x86_used_pages(&pool) == 0u);
}

static void test_kernel_runtime_rmrr_requires_explicit_shared_memory(void) {
    FakeX86PagePool pool = {0};
    FakeX86Hardware hardware = {.pool = &pool};
    SwypPageAllocator allocator = {.context = &pool, .ops = &fake_x86_allocator_ops};
    FakePlatformRuntime interrupt_runtime = {0};
    FakeVtdRegisters registers = {
        .capability = (UINT64_C(1) << 10) | UINT64_C(1),
        .extended_capability = UINT64_C(1) | (TEST_VTD_IRO << 8),
    };
    SwypX86Vtd vtd;
    SwypX86Vtd *units[1] = {&vtd};
    SwypX86VtdRouter router;
    SwypX86Iommu iommu;
    SwypKernelRuntime runtime;
    SwypAcpiPlatform acpi = {0};
    SwypDeviceGraph denied_graph;
    SwypDeviceGraph allowed_graph;
    SwypDeviceNode nic = {
        .id = 2u,
        .device_class = SWYP_DEVICE_CLASS_NETWORK,
        .bus = SWYP_DEVICE_BUS_PCI,
    };
    SwypDeviceResource dma = {
        .node_id = 2u,
        .kind = SWYP_DEVICE_RESOURCE_DMA,
        .start = UINT64_C(0x24000000),
        .length = UINT64_C(0x4000),
    };
    SwypDeviceResource config = {
        .node_id = 2u,
        .kind = SWYP_DEVICE_RESOURCE_CONFIG,
        .start = 0u,
        .length = UINT64_C(0x100),
    };
    SwypDeviceResource rmrr_shared = {
        .node_id = 2u,
        .kind = SWYP_DEVICE_RESOURCE_SHARED_MEMORY,
        .start = UINT64_C(0x31000000),
        .length = UINT64_C(0x2000),
    };
    SwypDriverDomainPolicy denied_policy;
    SwypDriverDomainPolicy allowed_policy;
    const SwypDriverDomain *domain = NULL;
    SwypAddressSpace *address_space = NULL;
    uint64_t requester = swyp_x86_pci_config_aux(0u, 2u, 3u, 1u);
    uint64_t translated = 0u;
    uint64_t rights = 0u;
    uint32_t pages_before_denied;

    interrupt_runtime.interrupts.context = &interrupt_runtime;
    interrupt_runtime.interrupts.ops = &fake_platform_interrupt_ops;
    config.aux = requester;
    acpi.dmar_unit_count = 1u;
    acpi.dmar_units[0].segment = 0u;
    acpi.dmar_units[0].flags = 1u;
    acpi.dmar_reserved_count = 1u;
    acpi.dmar_reserved[0].base = rmrr_shared.start;
    acpi.dmar_reserved[0].limit = rmrr_shared.start + rmrr_shared.length - 1u;
    acpi.dmar_reserved[0].segment = 0u;
    acpi.dmar_reserved[0].first_scope = 0u;
    acpi.dmar_reserved[0].scope_count = 1u;
    acpi.dmar_scope_count = 1u;
    acpi.dmar_scopes[0].type = 1u;
    acpi.dmar_scopes[0].segment = 0u;
    acpi.dmar_scopes[0].start_bus = 2u;
    acpi.dmar_scopes[0].path_count = 1u;
    acpi.dmar_scopes[0].path[0].device = 3u;
    acpi.dmar_scopes[0].path[0].function = 1u;

    CHECK(swyp_x86_vtd_init(&vtd, 0u, &allocator, &hardware, &fake_x86_hardware_ops, &registers,
                            &fake_vtd_register_ops) == SWYP_OK);
    CHECK(swyp_x86_vtd_router_init(&router, &acpi, units, 1u) == SWYP_OK);
    swyp_x86_iommu_init(&iommu, &router, swyp_x86_vtd_router_iommu_ops());
    CHECK(swyp_kernel_runtime_init(&runtime, &allocator, &hardware, &fake_x86_hardware_ops,
                                   &interrupt_runtime.interrupts, &iommu, NULL) == SWYP_OK);

    swyp_device_graph_init(&denied_graph);
    CHECK(swyp_device_graph_add_node(&denied_graph, &nic) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&denied_graph, &dma) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&denied_graph, &config) == SWYP_OK);
    swyp_driver_domain_policy_init(&denied_policy);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(
              &denied_policy, &denied_graph, &dma,
              SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE | SWYP_CAP_RIGHT_MAP) == SWYP_OK);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(&denied_policy, &denied_graph, &config,
                                                         SWYP_CAP_RIGHT_READ) == SWYP_OK);
    pages_before_denied = fake_x86_used_pages(&pool);
    CHECK(swyp_kernel_runtime_open_driver_domain(&runtime, &denied_graph, 2u, 699u, 10u, &denied_policy,
                                                 &domain, &address_space) == SWYP_ERR_DENIED);
    CHECK(domain == NULL && address_space == NULL);
    CHECK(!swyp_x86_iommu_domain_has_devices(&iommu, 699u, 10u));
    CHECK(test_vtd_domain(&vtd, 699u) == NULL);
    CHECK(fake_x86_used_pages(&pool) == pages_before_denied);

    swyp_device_graph_init(&allowed_graph);
    CHECK(swyp_device_graph_add_node(&allowed_graph, &nic) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&allowed_graph, &dma) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&allowed_graph, &config) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&allowed_graph, &rmrr_shared) == SWYP_OK);
    swyp_driver_domain_policy_init(&allowed_policy);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(
              &allowed_policy, &allowed_graph, &dma,
              SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE | SWYP_CAP_RIGHT_MAP) == SWYP_OK);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(&allowed_policy, &allowed_graph, &config,
                                                         SWYP_CAP_RIGHT_READ) == SWYP_OK);
    CHECK(swyp_driver_domain_policy_allow_exact_resource(
              &allowed_policy, &allowed_graph, &rmrr_shared,
              SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE | SWYP_CAP_RIGHT_MAP) == SWYP_OK);

    CHECK(swyp_kernel_runtime_open_driver_domain(&runtime, &allowed_graph, 2u, 700u, 11u, &allowed_policy,
                                                 &domain, &address_space) == SWYP_OK);
    CHECK(domain != NULL && address_space != NULL && swyp_x86_iommu_domain_has_devices(&iommu, 700u, 11u));
    CHECK(swyp_x86_vtd_query(&vtd, 700u, rmrr_shared.start + UINT64_C(0x321), &translated, &rights) == SWYP_OK);
    CHECK(translated == rmrr_shared.start + UINT64_C(0x321));
    CHECK(rights == (SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE));
    CHECK(swyp_kernel_runtime_close_driver_domain(&runtime, 700u, 11u) == SWYP_OK);
    CHECK(!swyp_x86_iommu_domain_has_devices(&iommu, 700u, 11u));
    CHECK(swyp_x86_vtd_query(&vtd, 700u, rmrr_shared.start, &translated, &rights) == SWYP_ERR_NOT_FOUND);
    CHECK(test_vtd_domain(&vtd, 700u) == NULL);
    CHECK(swyp_x86_vtd_shutdown(&vtd) == SWYP_OK);
    CHECK(fake_x86_used_pages(&pool) == 0u);
}

static SwypThreadContext test_scheduler_context(void) {
    SwypThreadContext context;
    memset(&context, 0, sizeof(context));
    context.abi_version = SWYP_KERNEL_ABI_VERSION;
    context.struct_size = (uint32_t)sizeof(context);
    context.arch = SWYP_ARCH_X86_64;
    context.used_bytes = 0u;
    return context;
}

static void test_scheduler_kernel_driver_cr3_dispatch(void) {
    FakeX86PagePool pool = {0};
    FakeX86Hardware hardware = {.pool = &pool};
    SwypPageAllocator allocator = {.context = &pool, .ops = &fake_x86_allocator_ops};
    SwypX86KernelRoot kernel_root;
    SwypX86DriverRuntimeManager driver_runtime;
    SwypX86SchedulerAddressRuntime address_runtime;
    SwypScheduler scheduler;
    SwypThreadContext context = test_scheduler_context();
    SwypAddressSpace *driver_contract = NULL;
    SwypX86AddressSpace *driver_space;
    const SwypSchedulerThread *current;
    uint64_t thread_id = 0u;
    uint64_t kernel_identity = UINT64_C(0x200000);
    uint64_t physical = 0u;
    uint64_t flags = 0u;
    int running_stopped = 0;

    CHECK(swyp_x86_64_kernel_root_init(&kernel_root, &allocator, &hardware, &fake_x86_hardware_ops,
                                       SWYP_X86_64_DIRECT_MAP_BASE, UINT64_C(0x40000000)) == SWYP_OK);
    CHECK(swyp_x86_64_kernel_root_map_identity(&kernel_root, kernel_identity, SWYP_X86_64_PAGE_SIZE,
                                               SWYP_MMU_READ | SWYP_MMU_EXECUTE | SWYP_MMU_GLOBAL, 0) == SWYP_OK);
    CHECK(swyp_x86_64_kernel_root_activate(&kernel_root) == SWYP_OK);
    CHECK(hardware.current_root == kernel_root.pml4_physical);

    swyp_x86_64_driver_runtime_init(&driver_runtime, &allocator, &hardware, &fake_x86_hardware_ops);
    CHECK(swyp_x86_64_driver_runtime_set_kernel_root(&driver_runtime, kernel_root.pml4_physical) == SWYP_OK);
    CHECK(swyp_x86_64_driver_runtime_open_domain(&driver_runtime, 700u, 11u, &driver_contract) == SWYP_OK);
    driver_space = swyp_x86_64_driver_runtime_x86_space(&driver_runtime, 700u, 11u);
    CHECK(driver_contract != NULL && driver_space != NULL);
    CHECK(swyp_x86_64_address_space_query(driver_space, kernel_identity, &physical, &flags) == SWYP_OK);
    CHECK(physical == kernel_identity && (flags & SWYP_MMU_EXECUTE) != 0u && (flags & SWYP_MMU_USER) == 0u);

    CHECK(swyp_x86_scheduler_address_runtime_init(&address_runtime, &kernel_root, &driver_runtime) == SWYP_OK);
    swyp_scheduler_init(&scheduler, &address_runtime, swyp_x86_scheduler_address_ops());
    CHECK(swyp_scheduler_add_thread(&scheduler, 1u, SWYP_SCHEDULER_THREAD_KERNEL, 0u, 0u, &context) == SWYP_OK);
    CHECK(swyp_scheduler_add_thread(&scheduler, 2u, SWYP_SCHEDULER_THREAD_DRIVER, 700u, 11u, &context) == SWYP_OK);
    CHECK(swyp_scheduler_add_thread(&scheduler, 3u, SWYP_SCHEDULER_THREAD_DRIVER, 700u, 12u, &context) == SWYP_OK);

    CHECK(swyp_scheduler_dispatch(&scheduler, &thread_id) == SWYP_OK && thread_id == 1u);
    CHECK(hardware.current_root == kernel_root.pml4_physical);
    CHECK(swyp_scheduler_dispatch(&scheduler, &thread_id) == SWYP_OK && thread_id == 2u);
    CHECK(hardware.current_root == driver_space->pml4_physical);
    current = swyp_scheduler_current(&scheduler);
    CHECK(current != NULL && current->id == 2u && current->state == SWYP_SCHEDULER_STATE_RUNNING);

    thread_id = UINT64_MAX;
    CHECK(swyp_scheduler_dispatch(&scheduler, &thread_id) == SWYP_ERR_DENIED);
    CHECK(thread_id == 0u && hardware.current_root == driver_space->pml4_physical);
    current = swyp_scheduler_current(&scheduler);
    CHECK(current != NULL && current->id == 2u);

    CHECK(swyp_scheduler_stop(&scheduler, 3u) == SWYP_OK);
    CHECK(swyp_scheduler_dispatch(&scheduler, &thread_id) == SWYP_OK && thread_id == 1u);
    CHECK(hardware.current_root == kernel_root.pml4_physical);
    CHECK(swyp_scheduler_stop_driver_epoch(&scheduler, 700u, 11u, &running_stopped) == SWYP_OK);
    CHECK(running_stopped == 0);
    CHECK(swyp_scheduler_thread(&scheduler, 2u)->state == SWYP_SCHEDULER_STATE_STOPPED);
    CHECK(swyp_scheduler_remove(&scheduler, 2u) == SWYP_OK);
    CHECK(swyp_x86_64_driver_runtime_close_domain(&driver_runtime, 700u, 11u) == SWYP_OK);

    hardware.current_root = 0u;
    CHECK(swyp_x86_64_kernel_root_destroy(&kernel_root) == SWYP_OK);
    CHECK(fake_x86_used_pages(&pool) == 0u);
}

static void test_x86_kernel_continuation(void) {
    SwypX86KernelContinuation continuation = {0};
    volatile uint32_t resumed = 0u;
    int64_t value = swyp_x86_kernel_continuation_capture(&continuation);
    if (value == 0) {
        resumed = 1u;
        swyp_x86_kernel_continuation_resume(&continuation, 77);
    }
    CHECK(value == 77);
    CHECK(resumed == 1u);
    CHECK(continuation.rsp != 0u && continuation.rip != 0u);
}

typedef struct FakePlatformBootMap {
    _Alignas(4096) uint8_t lapic[4096];
    _Alignas(4096) uint8_t ioapic[4096];
    _Alignas(4096) uint8_t ioapic2[4096];
    _Alignas(4096) uint8_t ecam_probe[4096];
    _Alignas(4096) uint8_t vtd_probe[0x4000];
    _Alignas(4096) uint8_t vtd_probe2[0x4000];
    uint64_t lapic_physical;
    uint64_t ioapic_physical;
    uint64_t ioapic_physical2;
    uint64_t ecam_physical;
    uint64_t vtd_physical;
    uint64_t vtd_physical2;
    FakeVtdRegisters *vtd_registers[2];
    uint32_t map_calls;
} FakePlatformBootMap;

static SwypStatus fake_platform_boot_map(void *context, SwypX86KernelRoot *kernel_root, SwypX86NativeMmu *native_mmu,
                                         uint64_t physical_address, uint64_t length,
                                         volatile void **virtual_address) {
    FakePlatformBootMap *map = (FakePlatformBootMap *)context;
    (void)kernel_root;
    (void)native_mmu;
    if (map == NULL || virtual_address == NULL || length == 0u) {
        return SWYP_ERR_INVALID;
    }
    map->map_calls += 1u;
    if (physical_address == map->lapic_physical && length == SWYP_X86_64_PAGE_SIZE) {
        *virtual_address = map->lapic;
        return SWYP_OK;
    }
    if (physical_address == map->ioapic_physical && length == SWYP_X86_64_PAGE_SIZE) {
        *virtual_address = map->ioapic;
        return SWYP_OK;
    }
    if (physical_address == map->ioapic_physical2 && length == SWYP_X86_64_PAGE_SIZE) {
        *virtual_address = map->ioapic2;
        return SWYP_OK;
    }
    if (physical_address == map->ecam_physical && length == UINT64_C(0x100000)) {
        *virtual_address = map->ecam_probe;
        return SWYP_OK;
    }
    if (physical_address == map->vtd_physical && length == UINT64_C(0x4000)) {
        *virtual_address = map->vtd_probe;
        return SWYP_OK;
    }
    if (physical_address == map->vtd_physical2 && length == UINT64_C(0x4000)) {
        *virtual_address = map->vtd_probe2;
        return SWYP_OK;
    }
    *virtual_address = NULL;
    return SWYP_ERR_NOT_FOUND;
}

static uint32_t fake_platform_boot_apic_id(void *context) {
    (void)context;
    return 2u;
}

static SwypStatus fake_platform_vtd_registers_for_unit(void *context, uint32_t unit_index, volatile void *mapped,
                                                       uint32_t length, void **register_context,
                                                       const SwypX86VtdRegisterOps **register_ops) {
    FakePlatformBootMap *map = (FakePlatformBootMap *)context;
    if (map == NULL || mapped == NULL || length != UINT64_C(0x4000) || register_context == NULL ||
        register_ops == NULL || unit_index >= 2u || map->vtd_registers[unit_index] == NULL) {
        return SWYP_ERR_INVALID;
    }
    *register_context = map->vtd_registers[unit_index];
    *register_ops = &fake_vtd_register_ops;
    return SWYP_OK;
}

static void test_x86_platform_boot_from_acpi(void) {
    FakeX86PagePool pool = {0};
    FakeX86Hardware hardware = {.pool = &pool};
    SwypPageAllocator allocator = {.context = &pool, .ops = &fake_x86_allocator_ops};
    SwypX86KernelRoot root;
    SwypX86NativeMmu native_mmu;
    SwypX86PrivilegeState privilege;
    SwypX86PlatformBoot platform;
    SwypAcpiPlatform acpi = {0};
    FakeVtdRegisters vtd_registers = {
        .capability = (UINT64_C(1) << 10) | UINT64_C(1),
        .extended_capability = UINT64_C(1) | (TEST_VTD_IRO << 8),
    };
    FakePlatformBootMap map = {
        .lapic_physical = UINT64_C(0xfee00000),
        .ioapic_physical = UINT64_C(0xfec00000),
        .ecam_physical = UINT64_C(0xe0000000),
        .vtd_physical = UINT64_C(0xfed90000),
    };
    SwypX86PlatformBootOps boot_ops = {
        .context = &map,
        .map_mmio = fake_platform_boot_map,
        .current_apic_id = fake_platform_boot_apic_id,
        .vtd_register_context = &vtd_registers,
        .vtd_register_ops = &fake_vtd_register_ops,
        .lapic_timer_initial_count = 1000u,
        .lapic_timer_divide_config = 3u,
    };
    SwypBootInfo boot_info;

    *(uint32_t *)(void *)(map.ioapic + 0x10u) = (UINT32_C(23) << 16) | UINT32_C(0x11);
    acpi.local_apic_address = map.lapic_physical;
    acpi.ioapic_count = 1u;
    acpi.ioapics[0].address = (uint32_t)map.ioapic_physical;
    acpi.ioapics[0].gsi_base = 0u;
    acpi.mcfg_segment_count = 1u;
    acpi.mcfg_segments[0].physical_base = map.ecam_physical;
    acpi.mcfg_segments[0].segment = 0u;
    acpi.mcfg_segments[0].start_bus = 0u;
    acpi.mcfg_segments[0].end_bus = 0u;
    acpi.dmar_unit_count = 1u;
    acpi.dmar_units[0].register_base = map.vtd_physical;
    acpi.dmar_units[0].segment = 0u;
    acpi.dmar_units[0].flags = 1u;

    CHECK(swyp_x86_64_kernel_root_init(&root, &allocator, &hardware, &fake_x86_hardware_ops,
                                       SWYP_X86_64_DIRECT_MAP_BASE, UINT64_C(0x100000000)) == SWYP_OK);
    CHECK(swyp_x86_64_kernel_root_activate(&root) == SWYP_OK);
    CHECK(swyp_x86_native_mmu_init_sparse(&native_mmu, SWYP_X86_64_DIRECT_MAP_BASE,
                                          UINT64_C(0x100000000)) == SWYP_OK);
    CHECK(swyp_x86_privilege_init(&privilege, UINT64_C(0x700000)) == SWYP_OK);
    CHECK(swyp_x86_platform_boot_init_from_acpi(&platform, &acpi, &allocator, &root, &native_mmu, &hardware,
                                                &fake_x86_hardware_ops, &privilege, &boot_ops) == SWYP_OK);
    CHECK(platform.acpi_ready != 0u && platform.apic_ready != 0u && platform.pci_ready != 0u &&
          platform.iommu_ready != 0u && platform.timer_ready != 0u && platform.runtime_ready != 0u);
    CHECK(platform.apic.redirection_count == 24u && platform.apic.destination_apic_id == 2u);
    CHECK(platform.pci.segment_count == 1u && platform.pci.segments[0].physical_base == map.ecam_physical);
    CHECK(map.map_calls == 4u);
    CHECK(swyp_x86_vtd_is_enabled(&platform.vtd));
    CHECK(platform.runtime.x86_driver_runtime.iommu == &platform.iommu);
    CHECK(swyp_x86_privilege_idt_handler(&privilege, SWYP_X86_IRQ_VECTOR_FIRST) != 0u);
    CHECK(swyp_x86_privilege_idt_handler(&privilege, SWYP_X86_SYSCALL_VECTOR) ==
          (uint64_t)(uintptr_t)&swyp_x86_syscall_entry);
    CHECK(swyp_x86_privilege_idt_handler(&privilege, SWYP_X86_TIMER_VECTOR) ==
          (uint64_t)(uintptr_t)&swyp_x86_lapic_timer_entry);
    CHECK(platform.runtime.preemption_ready != 0u && platform.timer.armed == 0u);

    swyp_boot_info_init(&boot_info, SWYP_ARCH_X86_64, SWYP_FIRMWARE_UEFI, 0u);
    boot_info.physical_memory.source = SWYP_MEMORY_MAP_UEFI;
    boot_info.boot_flags = SWYP_BOOT_FLAG_EXITED_BOOT_SERVICES | SWYP_BOOT_FLAG_PAGE_ALLOCATOR_READY |
                           SWYP_BOOT_FLAG_KERNEL_ROOT_ACTIVE | SWYP_BOOT_FLAG_DIRECT_MAP_READY |
                           SWYP_BOOT_FLAG_PRIVILEGE_READY | SWYP_BOOT_FLAG_EMERGENCY_IDT_READY |
                           SWYP_BOOT_FLAG_TRAP_ABI_READY | SWYP_BOOT_FLAG_PLATFORM_READY |
                           SWYP_BOOT_FLAG_SCHEDULER_READY | SWYP_BOOT_FLAG_DRIVER_ABI_READY;
    CHECK(swyp_kernel_validate_runtime_handoff(&boot_info, &allocator, &platform.runtime) == SWYP_OK);
    boot_info.boot_flags &= ~SWYP_BOOT_FLAG_SCHEDULER_READY;
    CHECK(swyp_kernel_validate_runtime_handoff(&boot_info, &allocator, &platform.runtime) == SWYP_ERR_CORRUPT);
    boot_info.boot_flags |= SWYP_BOOT_FLAG_SCHEDULER_READY;
    platform.runtime.x86_driver_runtime.kernel_pml4_physical ^= SWYP_X86_64_PAGE_SIZE;
    CHECK(swyp_kernel_validate_runtime_handoff(&boot_info, &allocator, &platform.runtime) == SWYP_ERR_CORRUPT);
    platform.runtime.x86_driver_runtime.kernel_pml4_physical = root.pml4_physical;
    CHECK(swyp_kernel_validate_runtime_handoff(&boot_info, &allocator, &platform.runtime) == SWYP_OK);

    CHECK(swyp_x86_vtd_shutdown(&platform.vtd) == SWYP_OK);
    hardware.current_root = 0u;
    CHECK(swyp_x86_64_kernel_root_destroy(&root) == SWYP_OK);
    CHECK(fake_x86_used_pages(&pool) == 0u);
}

/* QEMU's emulated intel-iommu does not report coherent page walks (ECAP.C), so
   the safe VT-d path refuses it. Boot must continue without an IOMMU, record
   why, and leave driver DMA refused instead of halting the kernel. */
static void test_x86_platform_boot_without_coherent_vtd(void) {
    FakeX86PagePool pool = {0};
    FakeX86Hardware hardware = {.pool = &pool};
    SwypPageAllocator allocator = {.context = &pool, .ops = &fake_x86_allocator_ops};
    SwypX86KernelRoot root;
    SwypX86NativeMmu native_mmu;
    SwypX86PrivilegeState privilege;
    SwypX86PlatformBoot platform;
    SwypAcpiPlatform acpi = {0};
    FakeVtdRegisters vtd_registers = {
        .capability = (UINT64_C(1) << 10) | UINT64_C(1),
        .extended_capability = TEST_VTD_IRO << 8, /* no coherent page-walk bit */
    };
    FakePlatformBootMap map = {
        .lapic_physical = UINT64_C(0xfee00000),
        .ioapic_physical = UINT64_C(0xfec00000),
        .ecam_physical = UINT64_C(0xe0000000),
        .vtd_physical = UINT64_C(0xfed90000),
    };
    SwypX86PlatformBootOps boot_ops = {
        .context = &map,
        .map_mmio = fake_platform_boot_map,
        .current_apic_id = fake_platform_boot_apic_id,
        .vtd_register_context = &vtd_registers,
        .vtd_register_ops = &fake_vtd_register_ops,
    };

    *(uint32_t *)(void *)(map.ioapic + 0x10u) = (UINT32_C(23) << 16) | UINT32_C(0x11);
    acpi.local_apic_address = map.lapic_physical;
    acpi.ioapic_count = 1u;
    acpi.ioapics[0].address = (uint32_t)map.ioapic_physical;
    acpi.ioapics[0].gsi_base = 0u;
    acpi.dmar_unit_count = 1u;
    acpi.dmar_units[0].register_base = map.vtd_physical;
    acpi.dmar_units[0].segment = 0u;
    acpi.dmar_units[0].flags = 1u;

    CHECK(swyp_x86_64_kernel_root_init(&root, &allocator, &hardware, &fake_x86_hardware_ops,
                                       SWYP_X86_64_DIRECT_MAP_BASE, UINT64_C(0x100000000)) == SWYP_OK);
    CHECK(swyp_x86_64_kernel_root_activate(&root) == SWYP_OK);
    CHECK(swyp_x86_native_mmu_init_sparse(&native_mmu, SWYP_X86_64_DIRECT_MAP_BASE,
                                          UINT64_C(0x100000000)) == SWYP_OK);
    CHECK(swyp_x86_privilege_init(&privilege, UINT64_C(0x700000)) == SWYP_OK);
    CHECK(swyp_x86_platform_boot_init_from_acpi(&platform, &acpi, &allocator, &root, &native_mmu, &hardware,
                                                &fake_x86_hardware_ops, &privilege, &boot_ops) == SWYP_OK);
    CHECK(platform.runtime_ready != 0u && platform.apic_ready != 0u);
    CHECK(platform.iommu_ready == 0u && platform.vtd_unit_count == 0u);
    CHECK(platform.iommu_status == SWYP_ERR_UNSUPPORTED);
    CHECK(platform.runtime.x86_driver_runtime.iommu == NULL);
    CHECK(!swyp_x86_vtd_is_enabled(&platform.vtd));

    hardware.current_root = 0u;
    CHECK(swyp_x86_64_kernel_root_destroy(&root) == SWYP_OK);
    CHECK(fake_x86_used_pages(&pool) == 0u);
}

static void test_x86_platform_boot_multi_vtd_router(void) {
    FakeX86PagePool pool = {0};
    FakeX86Hardware hardware = {.pool = &pool};
    SwypPageAllocator allocator = {.context = &pool, .ops = &fake_x86_allocator_ops};
    SwypX86KernelRoot root;
    SwypX86NativeMmu native_mmu;
    SwypX86PrivilegeState privilege;
    SwypX86PlatformBoot platform;
    SwypAcpiPlatform acpi = {0};
    FakeVtdRegisters registers0 = {
        .capability = (UINT64_C(1) << 10) | UINT64_C(1),
        .extended_capability = UINT64_C(1) | (TEST_VTD_IRO << 8),
    };
    FakeVtdRegisters registers1 = {
        .capability = (UINT64_C(1) << 10) | UINT64_C(1),
        .extended_capability = UINT64_C(1) | (TEST_VTD_IRO << 8),
    };
    FakePlatformBootMap map = {
        .lapic_physical = UINT64_C(0xfee00000),
        .ioapic_physical = UINT64_C(0xfec00000),
        .ioapic_physical2 = UINT64_C(0xfec01000),
        .ecam_physical = UINT64_C(0xe0000000),
        .vtd_physical = UINT64_C(0xfed90000),
        .vtd_physical2 = UINT64_C(0xfeda0000),
    };
    SwypX86PlatformBootOps boot_ops = {
        .context = &map,
        .map_mmio = fake_platform_boot_map,
        .current_apic_id = fake_platform_boot_apic_id,
        .vtd_registers_for_unit = fake_platform_vtd_registers_for_unit,
    };
    uint64_t requester_scoped = swyp_x86_pci_config_aux(0u, 2u, 3u, 1u);
    uint64_t requester_fallback = swyp_x86_pci_config_aux(0u, 4u, 1u, 0u);
    uint64_t requester_rmrr = swyp_x86_pci_config_aux(0u, 5u, 2u, 0u);

    map.vtd_registers[0] = &registers0;
    map.vtd_registers[1] = &registers1;
    *(uint32_t *)(void *)(map.ioapic + 0x10u) = (UINT32_C(23) << 16) | UINT32_C(0x11);
    *(uint32_t *)(void *)(map.ioapic2 + 0x10u) = (UINT32_C(23) << 16) | UINT32_C(0x11);
    acpi.local_apic_address = map.lapic_physical;
    acpi.ioapic_count = 2u;
    acpi.ioapics[0].address = (uint32_t)map.ioapic_physical;
    acpi.ioapics[0].gsi_base = 0u;
    acpi.ioapics[1].address = (uint32_t)map.ioapic_physical2;
    acpi.ioapics[1].gsi_base = 24u;
    acpi.dmar_unit_count = 2u;
    acpi.dmar_units[0].register_base = map.vtd_physical;
    acpi.dmar_units[0].segment = 0u;
    acpi.dmar_units[0].flags = 1u;
    acpi.dmar_units[1].register_base = map.vtd_physical2;
    acpi.dmar_units[1].segment = 0u;
    acpi.dmar_units[1].first_scope = 0u;
    acpi.dmar_units[1].scope_count = 1u;
    acpi.dmar_reserved_count = 1u;
    acpi.dmar_reserved[0].base = UINT64_C(0x9f000);
    acpi.dmar_reserved[0].limit = UINT64_C(0x9ffff);
    acpi.dmar_reserved[0].segment = 0u;
    acpi.dmar_reserved[0].first_scope = 1u;
    acpi.dmar_reserved[0].scope_count = 1u;
    acpi.dmar_scope_count = 2u;
    acpi.dmar_scopes[0].type = 1u;
    acpi.dmar_scopes[0].segment = 0u;
    acpi.dmar_scopes[0].start_bus = 2u;
    acpi.dmar_scopes[0].path_count = 1u;
    acpi.dmar_scopes[0].path[0].device = 3u;
    acpi.dmar_scopes[0].path[0].function = 1u;
    acpi.dmar_scopes[1].type = 1u;
    acpi.dmar_scopes[1].segment = 0u;
    acpi.dmar_scopes[1].start_bus = 5u;
    acpi.dmar_scopes[1].path_count = 1u;
    acpi.dmar_scopes[1].path[0].device = 2u;
    acpi.dmar_scopes[1].path[0].function = 0u;

    CHECK(swyp_x86_64_kernel_root_init(&root, &allocator, &hardware, &fake_x86_hardware_ops,
                                       SWYP_X86_64_DIRECT_MAP_BASE, UINT64_C(0x100000000)) == SWYP_OK);
    CHECK(swyp_x86_64_kernel_root_activate(&root) == SWYP_OK);
    CHECK(swyp_x86_native_mmu_init_sparse(&native_mmu, SWYP_X86_64_DIRECT_MAP_BASE,
                                          UINT64_C(0x100000000)) == SWYP_OK);
    CHECK(swyp_x86_privilege_init(&privilege, UINT64_C(0x700000)) == SWYP_OK);
    CHECK(swyp_x86_platform_boot_init_from_acpi(&platform, &acpi, &allocator, &root, &native_mmu, &hardware,
                                                &fake_x86_hardware_ops, &privilege, &boot_ops) == SWYP_OK);
    CHECK(platform.apic_unit_count == 2u && platform.iommu_ready != 0u && platform.vtd_unit_count == 2u &&
          platform.runtime_ready != 0u);
    CHECK(platform.apic_units[0] == &platform.apic && platform.apic_units[1] == &platform.apic_extra[0]);
    {
        SwypInterruptSource *interrupts = swyp_x86_apic_router_contract(&platform.apic_router);
        CHECK(interrupts != NULL);
        CHECK(interrupts->ops->bind(interrupts->context, 5u, 70u) == SWYP_OK);
        CHECK(platform.apic.routes[5].bound != 0u && platform.apic_extra[0].routes[5].bound == 0u);
        CHECK(interrupts->ops->bind(interrupts->context, 29u, 71u) == SWYP_OK);
        CHECK(platform.apic_extra[0].routes[5].bound != 0u);
        CHECK(interrupts->ops->unmask(interrupts->context, 29u) == SWYP_OK);
        CHECK(interrupts->ops->end_of_interrupt(interrupts->context, 29u) == SWYP_OK);
        CHECK(interrupts->ops->unbind(interrupts->context, 29u) == SWYP_OK);
        CHECK(interrupts->ops->unbind(interrupts->context, 5u) == SWYP_OK);
    }
    CHECK(platform.vtd_units[0] == &platform.vtd && platform.vtd_units[1] == &platform.vtd_extra[0]);
    CHECK(swyp_x86_iommu_attach_device(&platform.iommu, 700u, 11u, 10u, requester_scoped) == SWYP_OK);
    CHECK(test_vtd_has_device(platform.vtd_units[1], 700u, 10u));
    CHECK(swyp_x86_iommu_attach_device(&platform.iommu, 700u, 11u, 11u, requester_fallback) == SWYP_OK);
    CHECK(test_vtd_has_device(platform.vtd_units[0], 700u, 11u));
    CHECK(swyp_x86_iommu_attach_device(&platform.iommu, 701u, 12u, 12u, requester_rmrr) == SWYP_ERR_DENIED);
    CHECK(swyp_x86_iommu_detach_device(&platform.iommu, 700u, 11u, 10u) == SWYP_OK);
    CHECK(swyp_x86_iommu_detach_device(&platform.iommu, 700u, 11u, 11u) == SWYP_OK);
    CHECK(swyp_x86_vtd_shutdown(platform.vtd_units[1]) == SWYP_OK);
    CHECK(swyp_x86_vtd_shutdown(platform.vtd_units[0]) == SWYP_OK);
    hardware.current_root = 0u;
    CHECK(swyp_x86_64_kernel_root_destroy(&root) == SWYP_OK);
    CHECK(fake_x86_used_pages(&pool) == 0u);
}

int main(void) {
    test_boot_contracts();
    test_uefi_page_allocator();
    test_uefi_bootstrap_arena();
    test_uefi_acpi_root_capture();
    test_acpi_dmar_device_scopes();
    test_pe_identity_ranges();
    test_uefi_takeover_prepared_retry();
    test_uefi_exit_boot_services_retry();
    test_kernel_handoff_validation();
    test_x86_address_spaces();
    test_x86_address_space_transaction_rollback();
    test_x86_address_space_isolation();
    test_x86_address_space_inherits_kernel_supervisor_root();
    test_x86_kernel_root_direct_map();
    test_x86_kernel_root_failed_map_is_destroyable();
    test_kernel_takeover_plan();
    test_kernel_takeover_unactivated_cleanup();
    test_kernel_takeover_external_activation_confirmation();
    test_x86_native_backend_nonprivileged_contracts();
    test_x86_platform_map_registry_failure_rolls_back();
    test_x86_privilege_descriptors();
    test_x86_privilege_accepts_busy_tss_after_ltr();
    test_x86_trap_abi();
    test_x86_apic();
    test_x86_lapic_timer_modes();
    test_x86_iommu();
    test_x86_vtd_legacy_backend();
    test_x86_vtd_router_multi_drhd();
    test_x86_pci_ecam();
    test_x86_vtd_router_pci_bridge_topology();
    test_capabilities();
    test_capability_generation_exhaustion();
    test_driver_domains();
    test_device_broker();
    test_device_platform();
    test_x86_driver_image_parser_and_loader();
    test_x86_driver_runtime_end_to_end();
    test_kernel_runtime_driver_domain_lifecycle();
    test_kernel_runtime_vtd_auto_attach_and_dma();
    test_kernel_runtime_rmrr_requires_explicit_shared_memory();
    test_scheduler_kernel_driver_cr3_dispatch();
    test_x86_kernel_continuation();
    test_x86_platform_boot_from_acpi();
    test_x86_platform_boot_without_coherent_vtd();
    test_x86_platform_boot_multi_vtd_router();
    test_ipc();
    test_device_graph_wire();
    test_device_graph_adversarial();
    if (failures != 0) {
        fprintf(stderr, "swypik-kernel host core tests: %d failure(s)\n", failures);
        return 1;
    }
    puts("swypik-kernel host core tests: PASS");
    return 0;
}
