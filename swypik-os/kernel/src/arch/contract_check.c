#include "swypik/kernel/contracts.h"

#if defined(SWYP_CONTRACT_X86_64)
#include "swypik/arch/x86_64/context.h"
typedef SwypX86_64ThreadContext SwypSelectedArchContext;
#define SWYP_SELECTED_ARCH SWYP_ARCH_X86_64
#elif defined(SWYP_CONTRACT_ARM64)
#include "swypik/arch/arm64/context.h"
typedef SwypArm64ThreadContext SwypSelectedArchContext;
#define SWYP_SELECTED_ARCH SWYP_ARCH_ARM64
#elif defined(SWYP_CONTRACT_RISCV64)
#include "swypik/arch/riscv64/context.h"
typedef SwypRiscv64ThreadContext SwypSelectedArchContext;
#define SWYP_SELECTED_ARCH SWYP_ARCH_RISCV64
#else
#error "define exactly one SWYP_CONTRACT_* architecture"
#endif

_Static_assert(sizeof(void *) == 8u, "M1 target contracts are 64-bit only");
_Static_assert(sizeof(SwypSelectedArchContext) <= SWYP_THREAD_CONTEXT_STORAGE_BYTES,
               "selected arch context exceeds portable ThreadContext storage");
_Static_assert(_Alignof(SwypThreadContext) >= 16u, "ThreadContext storage must remain 16-byte aligned");

int swyp_arch_contract_compile_probe(void) {
    SwypThreadContext context = {0};
    context.abi_version = SWYP_KERNEL_ABI_VERSION;
    context.struct_size = (uint32_t)sizeof(context);
    context.arch = SWYP_SELECTED_ARCH;
    context.used_bytes = (uint32_t)sizeof(SwypSelectedArchContext);
    return context.used_bytes <= SWYP_THREAD_CONTEXT_STORAGE_BYTES ? 0 : 1;
}
