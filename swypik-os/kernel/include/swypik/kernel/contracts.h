#ifndef SWYPIK_KERNEL_CONTRACTS_H
#define SWYPIK_KERNEL_CONTRACTS_H

#include "swypik/kernel/abi.h"

#define SWYP_BOOT_INFO_MAGIC UINT64_C(0x49424B4950595753)
#define SWYP_THREAD_CONTEXT_STORAGE_BYTES 320u

enum {
    SWYP_BOOT_FLAG_EXITED_BOOT_SERVICES = UINT64_C(1) << 0,
    SWYP_BOOT_FLAG_PAGE_ALLOCATOR_READY = UINT64_C(1) << 1,
    SWYP_BOOT_FLAG_KERNEL_ROOT_ACTIVE = UINT64_C(1) << 2,
    SWYP_BOOT_FLAG_DIRECT_MAP_READY = UINT64_C(1) << 3,
    SWYP_BOOT_FLAG_PRIVILEGE_READY = UINT64_C(1) << 4,
    SWYP_BOOT_FLAG_EMERGENCY_IDT_READY = UINT64_C(1) << 5,
    SWYP_BOOT_FLAG_TRAP_ABI_READY = UINT64_C(1) << 6,
    SWYP_BOOT_FLAG_PLATFORM_READY = UINT64_C(1) << 7,
    SWYP_BOOT_FLAG_SCHEDULER_READY = UINT64_C(1) << 8,
    SWYP_BOOT_FLAG_DRIVER_ABI_READY = UINT64_C(1) << 9,
    SWYP_BOOT_FLAG_IOMMU_READY = UINT64_C(1) << 10
};

typedef enum SwypFirmwareKind {
    SWYP_FIRMWARE_UNKNOWN = 0,
    SWYP_FIRMWARE_UEFI = 1,
    SWYP_FIRMWARE_DEVICE_TREE = 2,
    SWYP_FIRMWARE_ACPI = 3
} SwypFirmwareKind;

typedef enum SwypMemoryMapSource {
    SWYP_MEMORY_MAP_UNKNOWN = 0,
    SWYP_MEMORY_MAP_UEFI = 1,
    SWYP_MEMORY_MAP_DEVICE_TREE = 2,
    SWYP_MEMORY_MAP_FIRMWARE = 3
} SwypMemoryMapSource;

typedef struct SwypArchInfo {
    uint32_t abi_version;
    uint32_t struct_size;
    SwypArch arch;
    SwypEndianness endianness;
    uint32_t native_word_bits;
    uint32_t base_page_shift;
    uint64_t cpu_id;
    uint64_t feature_bits[4];
} SwypArchInfo;

typedef struct SwypPhysicalMemoryMap {
    uint32_t abi_version;
    uint32_t struct_size;
    SwypMemoryMapSource source;
    uint32_t descriptor_version;
    uint64_t entries_address;
    uint64_t buffer_bytes;
    uint32_t entry_count;
    uint32_t entry_stride;
    uint64_t firmware_map_key;
} SwypPhysicalMemoryMap;

typedef struct SwypBootInfo {
    uint64_t magic;
    uint32_t abi_version;
    uint32_t struct_size;
    SwypFirmwareKind firmware;
    uint32_t reserved0;
    uint64_t firmware_system_table;
    SwypArchInfo arch;
    SwypPhysicalMemoryMap physical_memory;
    uint64_t acpi_rsdp_address;
    uint32_t acpi_rsdp_length;
    uint32_t acpi_revision;
    uint64_t boot_flags;
} SwypBootInfo;

typedef struct SwypPageAllocatorOps {
    SwypStatus (*allocate)(void *context, uint64_t page_count, uint64_t alignment_pages, uint64_t *physical_address);
    SwypStatus (*release)(void *context, uint64_t physical_address, uint64_t page_count);
} SwypPageAllocatorOps;

typedef struct SwypPageAllocator {
    void *context;
    const SwypPageAllocatorOps *ops;
} SwypPageAllocator;

enum {
    SWYP_MMU_READ = UINT64_C(1) << 0,
    SWYP_MMU_WRITE = UINT64_C(1) << 1,
    SWYP_MMU_EXECUTE = UINT64_C(1) << 2,
    SWYP_MMU_USER = UINT64_C(1) << 3,
    SWYP_MMU_DEVICE = UINT64_C(1) << 4,
    SWYP_MMU_GLOBAL = UINT64_C(1) << 5
};

typedef struct SwypAddressSpaceOps {
    SwypStatus (*map)(void *context, uint64_t virtual_address, uint64_t physical_address, uint64_t page_count, uint64_t flags);
    SwypStatus (*unmap)(void *context, uint64_t virtual_address, uint64_t page_count);
    SwypStatus (*protect)(void *context, uint64_t virtual_address, uint64_t page_count, uint64_t flags);
    SwypStatus (*activate)(void *context);
} SwypAddressSpaceOps;

typedef struct SwypAddressSpace {
    void *context;
    const SwypAddressSpaceOps *ops;
} SwypAddressSpace;

typedef struct SwypInterruptSourceOps {
    SwypStatus (*bind)(void *context, uint32_t source_id, uint32_t vector);
    SwypStatus (*unbind)(void *context, uint32_t source_id);
    SwypStatus (*mask)(void *context, uint32_t source_id);
    SwypStatus (*unmask)(void *context, uint32_t source_id);
    SwypStatus (*end_of_interrupt)(void *context, uint32_t source_id);
} SwypInterruptSourceOps;

typedef struct SwypInterruptSource {
    void *context;
    const SwypInterruptSourceOps *ops;
} SwypInterruptSource;

typedef struct SwypTimerSourceOps {
    uint64_t (*now_ns)(void *context);
    SwypStatus (*arm_deadline_ns)(void *context, uint64_t deadline_ns);
    SwypStatus (*cancel)(void *context);
} SwypTimerSourceOps;

typedef struct SwypTimerSource {
    void *context;
    const SwypTimerSourceOps *ops;
} SwypTimerSource;

typedef struct SwypThreadContext {
    uint32_t abi_version;
    uint32_t struct_size;
    SwypArch arch;
    uint32_t used_bytes;
    uint64_t flags;
    _Alignas(16) uint8_t storage[SWYP_THREAD_CONTEXT_STORAGE_BYTES];
} SwypThreadContext;

void swyp_arch_info_init(SwypArchInfo *info, SwypArch arch, SwypEndianness endianness, uint32_t page_shift);
void swyp_boot_info_init(SwypBootInfo *boot_info, SwypArch arch, SwypFirmwareKind firmware, uint64_t firmware_system_table);

#endif
