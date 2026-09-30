#include "swypik/kernel/contracts.h"

static void swyp_zero(void *ptr, size_t size) {
    uint8_t *bytes = (uint8_t *)ptr;
    size_t i;
    for (i = 0; i < size; ++i) {
        bytes[i] = 0;
    }
}

void swyp_arch_info_init(SwypArchInfo *info, SwypArch arch, SwypEndianness endianness, uint32_t page_shift) {
    if (info == NULL) {
        return;
    }
    swyp_zero(info, sizeof(*info));
    info->abi_version = SWYP_KERNEL_ABI_VERSION;
    info->struct_size = (uint32_t)sizeof(*info);
    info->arch = arch;
    info->endianness = endianness;
    info->native_word_bits = 64u;
    info->base_page_shift = page_shift;
}

void swyp_boot_info_init(SwypBootInfo *boot_info, SwypArch arch, SwypFirmwareKind firmware, uint64_t firmware_system_table) {
    if (boot_info == NULL) {
        return;
    }
    swyp_zero(boot_info, sizeof(*boot_info));
    boot_info->magic = SWYP_BOOT_INFO_MAGIC;
    boot_info->abi_version = SWYP_KERNEL_ABI_VERSION;
    boot_info->struct_size = (uint32_t)sizeof(*boot_info);
    boot_info->firmware = firmware;
    boot_info->firmware_system_table = firmware_system_table;
    swyp_arch_info_init(&boot_info->arch, arch, SWYP_ENDIAN_LITTLE, 12u);
    boot_info->physical_memory.abi_version = SWYP_KERNEL_ABI_VERSION;
    boot_info->physical_memory.struct_size = (uint32_t)sizeof(boot_info->physical_memory);
}
