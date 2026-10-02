#include "swypik/boot/uefi_bootstrap.h"
#include "swypik/boot/uefi_acpi.h"
#include "swypik/boot/uefi_handoff.h"
#include "swypik/boot/uefi_init.h"
#include "swypik/kernel/init.h"
#include "swypik/boot/uefi_memory.h"
#include "swypik/boot/uefi_switch.h"
#include "swypik/boot/uefi_takeover.h"
#include "swypik/arch/x86_64/privilege.h"
#include "swypik/arch/x86_64/platform_boot.h"
#include "swypik/arch/x86_64/trap.h"
#include "swypik/kernel/kernel_entry.h"
#include "swypik/uefi/uefi.h"

#define SWYP_UEFI_MEMORY_MAP_BYTES (128u * 1024u)
#define SWYP_UEFI_BOOTSTRAP_TABLE_PAGES 512u
#define SWYP_UEFI_BOOTSTRAP_STACK_PAGES 16u

static _Alignas(16) uint8_t g_memory_map_storage[SWYP_UEFI_MEMORY_MAP_BYTES];
static SwypBootInfo g_boot_info;
static SwypUefiPageAllocator g_page_allocator;
static SwypUefiBootstrapArena g_bootstrap_arena;
static SwypUefiTakeover g_takeover;
static SwypX86PrivilegeState g_privilege_state;
static SwypX86TrapDispatchTable g_trap_table;
static SwypX86FatalTrapRecord g_fatal_trap_record;
static SwypX86PlatformBoot g_platform_boot;

typedef struct SwypUefiContinuationContext {
    SwypBootInfo *boot_info;
    SwypUefiPageAllocator *page_allocator;
    SwypUefiTakeover *takeover;
} SwypUefiContinuationContext;

static SwypUefiContinuationContext g_continuation;

static const EFI_CHAR16 kBanner[] = {
    'S','w','y','p','i','k','O','S',' ','n','a','t','i','v','e',' ','k','e','r','n','e','l',' ','s','e','e','d','\r','\n',0
};
static const EFI_CHAR16 kStage[] = {
    's','t','a','g','e','=','u','e','f','i','-','l','o','a','d','e','r',' ','a','r','c','h','=','x','8','6','_','6','4','\r','\n',0
};
static const EFI_CHAR16 kExitFail[] = {
    'e','x','i','t','-','b','o','o','t','-','s','e','r','v','i','c','e','s','=','f','a','i','l','e','d','\r','\n',0
};
static const EFI_CHAR16 kHandoff[] = {
    'h','a','n','d','o','f','f','=','k','e','r','n','e','l',' ','b','o','o','t','-','s','e','r','v','i','c','e','s','=','e','x','i','t','i','n','g','\r','\n',0
};

static EFI_STATUS swyp_print(EFI_SYSTEM_TABLE *system_table, const EFI_CHAR16 *text) {
    if (system_table == 0 || system_table->ConOut == 0 || system_table->ConOut->OutputString == 0) {
        return EFI_DEVICE_ERROR;
    }
    return system_table->ConOut->OutputString(system_table->ConOut, text);
}

static void SWYP_EFIAPI swyp_uefi_after_takeover(void *context) {
    SwypUefiContinuationContext *continuation = (SwypUefiContinuationContext *)context;
    SwypX86NativeMmu *native_mmu;
    const SwypX86AddressSpaceHardwareOps *native_ops;
    SwypPageAllocator *allocator;
    uint64_t stack_top;
    uint64_t ist_top;
    uint64_t probe_page = 0u;
    uint64_t mapped_physical = 0u;
    uint64_t mapped_flags = 0u;
    uint64_t mapped_page_size = 0u;
    volatile uint64_t *probe_word;
    const uint64_t probe_pattern = UINT64_C(0x535759504d4d5531);
    void *probe_virtual;
    if (continuation == NULL || continuation->boot_info == NULL || continuation->page_allocator == NULL ||
        continuation->takeover == NULL || swyp_uefi_takeover_confirm_active(continuation->takeover) != SWYP_OK) {
        swyp_kernel_halt();
    }
    stack_top = swyp_uefi_takeover_stack_top(continuation->takeover);
    ist_top = swyp_uefi_bootstrap_ist_top(continuation->takeover->arena);
    if (stack_top == 0u || ist_top == 0u || swyp_x86_privilege_init(&g_privilege_state, stack_top) != SWYP_OK ||
        swyp_x86_privilege_set_ist(&g_privilege_state, 1u, ist_top) != SWYP_OK ||
        swyp_x86_privilege_install_emergency_idt(&g_privilege_state,
                                                 (uint64_t)(uintptr_t)&swyp_x86_emergency_halt_stub, 1u) != SWYP_OK) {
        swyp_kernel_halt();
    }
    swyp_x86_privilege_load_gdt_tss(&g_privilege_state.gdtr, SWYP_X86_SELECTOR_TSS);
    swyp_x86_privilege_load_idt(&g_privilege_state.idtr);
    continuation->boot_info->boot_flags |= SWYP_BOOT_FLAG_PRIVILEGE_READY | SWYP_BOOT_FLAG_EMERGENCY_IDT_READY;

    g_fatal_trap_record = (SwypX86FatalTrapRecord){0};
    swyp_x86_trap_table_init(&g_trap_table, &g_fatal_trap_record);
    {
        uint32_t vector;
        for (vector = 0u; vector < SWYP_X86_EXCEPTION_COUNT; ++vector) {
            if (swyp_x86_trap_set_handler(&g_trap_table, vector, swyp_x86_trap_record_fatal) != SWYP_OK) {
                swyp_kernel_halt();
            }
        }
    }
    if (swyp_x86_trap_bind_dispatch_table(&g_trap_table) != SWYP_OK ||
        swyp_x86_trap_install_exception_idt(&g_privilege_state, 1u) != SWYP_OK) {
        swyp_kernel_halt();
    }
    swyp_x86_privilege_load_idt(&g_privilege_state.idtr);
    continuation->boot_info->boot_flags |= SWYP_BOOT_FLAG_TRAP_ABI_READY;
    native_mmu = swyp_kernel_takeover_native_mmu(&continuation->takeover->takeover);
    native_ops = swyp_kernel_takeover_native_ops(&continuation->takeover->takeover);
    allocator = swyp_uefi_page_allocator_contract(continuation->page_allocator);
    if (native_mmu == NULL || native_ops == NULL || native_ops->physical_to_virtual == NULL || allocator == NULL ||
        allocator->ops == NULL || allocator->ops->allocate == NULL || allocator->ops->release == NULL ||
        allocator->ops->allocate(allocator->context, 1u, 1u, &probe_page) != SWYP_OK) {
        swyp_kernel_halt();
    }
    probe_virtual = native_ops->physical_to_virtual(native_mmu, probe_page);
    if (probe_virtual == NULL ||
        swyp_x86_64_kernel_root_query(&continuation->takeover->takeover.root, (uint64_t)(uintptr_t)probe_virtual,
                                      &mapped_physical, &mapped_flags, &mapped_page_size) != SWYP_OK ||
        mapped_physical != probe_page || mapped_page_size == 0u ||
        (mapped_flags & (SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_GLOBAL)) !=
            (SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_GLOBAL) ||
        (mapped_flags & (SWYP_MMU_EXECUTE | SWYP_MMU_USER | SWYP_MMU_DEVICE)) != 0u) {
        swyp_kernel_halt();
    }
    probe_word = (volatile uint64_t *)probe_virtual;
    *probe_word = probe_pattern;
    if (*probe_word != probe_pattern) {
        swyp_kernel_halt();
    }
    *probe_word = 0u;
    if (allocator->ops->release(allocator->context, probe_page, 1u) != SWYP_OK) {
        swyp_kernel_halt();
    }
    continuation->boot_info->boot_flags |= SWYP_BOOT_FLAG_KERNEL_ROOT_ACTIVE | SWYP_BOOT_FLAG_DIRECT_MAP_READY;
    if (swyp_x86_platform_boot_init(&g_platform_boot, continuation->boot_info, allocator,
                                    &continuation->takeover->takeover.root, native_mmu, native_ops,
                                    &g_privilege_state) != SWYP_OK || g_platform_boot.runtime_ready == 0u ||
        swyp_kernel_runtime_scheduler(&g_platform_boot.runtime) == NULL ||
        swyp_kernel_runtime_device_broker(&g_platform_boot.runtime) == NULL) {
        swyp_kernel_halt();
    }
    continuation->boot_info->boot_flags |=
        SWYP_BOOT_FLAG_PLATFORM_READY | SWYP_BOOT_FLAG_SCHEDULER_READY | SWYP_BOOT_FLAG_DRIVER_ABI_READY;
    if (g_platform_boot.iommu_ready != 0u) {
        continuation->boot_info->boot_flags |= SWYP_BOOT_FLAG_IOMMU_READY;
    }
    if ((continuation->boot_info->boot_flags & SWYP_BOOT_FLAG_INIT_IMAGE_READY) != 0u) {
        const uint8_t *image = native_ops->physical_to_virtual(native_mmu, continuation->boot_info->init_image_address);
        SwypStatus init_result = swyp_kernel_run_init(continuation->boot_info, &g_platform_boot.runtime,
                                                       &g_privilege_state, image);
        continuation->boot_info->init_status = init_result;
        if (init_result != SWYP_OK) {
            continuation->boot_info->init_status = init_result;
            continuation->boot_info->boot_flags |= SWYP_BOOT_FLAG_INIT_FAILED;
        }
    }
    swyp_kernel_entry_runtime(continuation->boot_info, allocator, &g_platform_boot.runtime);
}

EFI_STATUS SWYP_EFIAPI efi_main(EFI_HANDLE image_handle, EFI_SYSTEM_TABLE *system_table) {
    EFI_STATUS status;
    SwypStatus acpi_status;
    uint64_t root_physical;
    uint64_t stack_top;
    swyp_boot_info_init(&g_boot_info, SWYP_ARCH_X86_64, SWYP_FIRMWARE_UEFI,
                        (uint64_t)(uintptr_t)system_table);
    acpi_status = swyp_uefi_capture_acpi_root(system_table, &g_boot_info);
    if (acpi_status != SWYP_OK && acpi_status != SWYP_ERR_NOT_FOUND) {
        return EFI_DEVICE_ERROR;
    }

    status = swyp_print(system_table, kBanner);
    if (status != EFI_SUCCESS) {
        return status;
    }
    status = swyp_print(system_table, kStage);
    if (status != EFI_SUCCESS) {
        return status;
    }
    status = swyp_uefi_load_init(image_handle, system_table, &g_boot_info);
    if (status != EFI_SUCCESS) {
        return status;
    }

    if (swyp_uefi_bootstrap_arena_init(system_table, &g_bootstrap_arena, SWYP_UEFI_BOOTSTRAP_TABLE_PAGES,
                                       SWYP_UEFI_BOOTSTRAP_STACK_PAGES) != SWYP_OK) {
        return EFI_DEVICE_ERROR;
    }
    if (swyp_uefi_takeover_init(image_handle, system_table, &g_bootstrap_arena, &g_takeover) != SWYP_OK) {
        (void)swyp_uefi_bootstrap_arena_release(system_table, &g_bootstrap_arena);
        return EFI_DEVICE_ERROR;
    }

    (void)swyp_print(system_table, kHandoff);
    status = swyp_uefi_exit_boot_services_prepared(image_handle, system_table, g_memory_map_storage,
                                                   (EFI_UINTN)sizeof(g_memory_map_storage), &g_boot_info, 4u,
                                                   swyp_uefi_takeover_prepare_exit, &g_takeover);
    if (status != EFI_SUCCESS) {
        (void)swyp_print(system_table, kExitFail);
        if (g_takeover.takeover.prepared != 0u && g_takeover.takeover.activated == 0u) {
            (void)swyp_kernel_takeover_destroy_unactivated(&g_takeover.takeover);
        }
        (void)swyp_uefi_bootstrap_arena_release(system_table, &g_bootstrap_arena);
        return status;
    }
    if (swyp_uefi_page_allocator_init(&g_page_allocator, &g_boot_info.physical_memory) != SWYP_OK) {
        swyp_kernel_halt();
    }
    g_boot_info.boot_flags |= SWYP_BOOT_FLAG_PAGE_ALLOCATOR_READY;
    /* Boot services are gone. Never dereference the firmware system table from
       the new kernel root unless runtime-service mapping is implemented. */
    g_boot_info.firmware_system_table = 0u;
    root_physical = swyp_uefi_takeover_root_physical(&g_takeover);
    stack_top = swyp_uefi_takeover_stack_top(&g_takeover);
    if (root_physical == 0u || stack_top == 0u) {
        swyp_kernel_halt();
    }
    g_continuation.boot_info = &g_boot_info;
    g_continuation.page_allocator = &g_page_allocator;
    g_continuation.takeover = &g_takeover;
    swyp_uefi_takeover_switch(root_physical, stack_top, swyp_uefi_after_takeover, &g_continuation);
}

/* LLD's EFI default entry spelling is EfiMain. Keep the historical efi_main
   symbol for the MinGW build and expose the standard alias for PE/COFF EFI
   linkers. */
EFI_STATUS SWYP_EFIAPI EfiMain(EFI_HANDLE image_handle, EFI_SYSTEM_TABLE *system_table) {
    return efi_main(image_handle, system_table);
}
