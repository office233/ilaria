package coreir

import (
	"bytes"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"

	"swyp-lang/internal/storageabi"
)

type NativeProfile string

const (
	NativeSafe NativeProfile = "safe"
	NativeFast NativeProfile = "fast"
)

// EmitNativeC lowers a validated pure Core IR module to a standalone C11
// program. Safe preserves Core's exact function/instruction/terminator fuel
// accounting. Fast keeps bounded execution but charges fuel at basic-block
// entries, allowing the C compiler to optimize arithmetic more aggressively.
func EmitNativeC(m Module, entry string, profile NativeProfile) ([]byte, error) {
	if profile != NativeSafe && profile != NativeFast {
		return nil, fmt.Errorf("unknown native profile %q", profile)
	}
	if err := m.Validate(); err != nil {
		return nil, err
	}
	functions := make(map[string]Function, len(m.Functions))
	for _, f := range m.Functions {
		functions[f.Name] = f
		if semanticsForFunction(f).Purity != "pure" {
			return nil, diagnostic("effectful_program", "native Core AOT accepts pure functions only")
		}
	}
	root, ok := functions[entry]
	if !ok {
		return nil, diagnostic("unknown_function", entry)
	}
	for _, p := range root.Params {
		if p.Type == Bytes {
			return nil, fmt.Errorf("native Core AOT: CLI bytes parameters are unsupported")
		}
	}

	names := make(map[string]string, len(m.Functions))
	recursive := recursiveCoreFunctions(m)
	ordered := append([]Function(nil), m.Functions...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Name < ordered[j].Name })
	for i, f := range ordered {
		names[f.Name] = fmt.Sprintf("swyp_core_fn_%d", i)
	}

	var b bytes.Buffer
	fmt.Fprintf(&b, "#define SWYP_MAX_CALL_DEPTH %d\n", MaxCallDepth)
	b.WriteString(coreNativeRuntime)
	fmt.Fprintf(&b, "#define SWYP_STORAGE_BLOCKS %d\n#define SWYP_STORAGE_BYTES UINT64_C(%d)\n#define SWYP_RUN_BYTES %d\n#define SWYP_MODULE_BYTES %d\n",
		storageabi.DefaultMaxBlocks, storageabi.DefaultMaxBytes, MaxRunByteArenaBytes, len(m.Data))
	fmt.Fprintf(&b, "static unsigned char swyp_byte_data[SWYP_MODULE_BYTES+SWYP_RUN_BYTES+1]={")
	for _, octet := range m.Data {
		fmt.Fprintf(&b, "%d,", octet)
	}
	fmt.Fprintln(&b, "0};")
	b.WriteString(coreNativeStorageRuntime)
	for _, f := range ordered {
		fmt.Fprintf(&b, "%s;\n", coreCSignature(f, names[f.Name], profile == NativeFast && shouldInlineCoreFunction(f, recursive[f.Name])))
	}
	b.WriteByte('\n')
	for _, f := range ordered {
		if err := emitCoreFunction(&b, f, names, profile, recursive[f.Name]); err != nil {
			return nil, err
		}
	}
	emitCoreMain(&b, root, names[entry])
	return b.Bytes(), nil
}

func coreCType(t Type) string {
	switch t {
	case I64:
		return "int64_t"
	case U64, Bytes:
		return "uint64_t"
	case F64, IEEE64:
		return "double"
	case Bool:
		return "bool"
	case Void:
		return "void"
	default:
		panic("validated unsupported core type")
	}
}

func coreCSignature(f Function, name string, forceInline bool) string {
	parts := make([]string, len(f.Params))
	for i, p := range f.Params {
		parts[i] = fmt.Sprintf("%s p%d", coreCType(p.Type), i)
	}
	args := "void"
	if len(parts) != 0 {
		args = strings.Join(parts, ",")
	}
	prefix := "static"
	if forceInline {
		prefix = "SWYP_INLINE"
	}
	return fmt.Sprintf("%s %s %s(%s)", prefix, coreCType(f.Result), name, args)
}

func emitCoreFunction(b *bytes.Buffer, f Function, names map[string]string, profile NativeProfile, recursive bool) error {
	fmt.Fprintf(b, "%s {\n", coreCSignature(f, names[f.Name], profile == NativeFast && shouldInlineCoreFunction(f, recursive)))
	fmt.Fprintln(b, "swyp_enter_call();")
	if profile == NativeSafe || recursive {
		fmt.Fprintln(b, "swyp_tick();")
	}
	for i, t := range f.Slots {
		fmt.Fprintf(b, "%s s%d;\n", coreCType(t), i)
	}
	for i := range f.Params {
		fmt.Fprintf(b, "s%d=p%d;\n", i, i)
	}
	for bi, block := range f.Blocks {
		fmt.Fprintf(b, "b%d:\n", bi)
		for _, ins := range block.Instructions {
			if profile == NativeSafe {
				fmt.Fprintln(b, "swyp_tick();")
			}
			line, err := coreCInstruction(f, ins, names)
			if err != nil {
				return err
			}
			fmt.Fprintln(b, line)
		}
		if profile == NativeSafe {
			fmt.Fprintln(b, "swyp_tick();")
		}
		if err := emitCoreTerminator(b, f, block.Terminator, bi, profile); err != nil {
			return err
		}
	}
	fmt.Fprintln(b, "}")
	fmt.Fprintln(b)
	return nil
}

// shouldInlineCoreFunction is deliberately conservative: forced inlining is
// limited to small non-recursive helpers where call overhead can dominate.
// Larger functions remain under the C compiler's own inliner to avoid code
// growth and instruction-cache regressions.
func shouldInlineCoreFunction(f Function, recursive bool) bool {
	if recursive {
		return false
	}
	const maxInstructions = 48
	n := 0
	for _, block := range f.Blocks {
		n += len(block.Instructions) + 1 // include terminator
		if n > maxInstructions {
			return false
		}
	}
	return true
}

func recursiveCoreFunctions(m Module) map[string]bool {
	edges := make(map[string][]string, len(m.Functions))
	for _, f := range m.Functions {
		seen := map[string]bool{}
		for _, block := range f.Blocks {
			for _, ins := range block.Instructions {
				if ins.Op == "call" && !seen[ins.Callee] {
					seen[ins.Callee] = true
					edges[f.Name] = append(edges[f.Name], ins.Callee)
				}
			}
		}
	}
	result := make(map[string]bool, len(m.Functions))
	for _, f := range m.Functions {
		visiting := map[string]bool{}
		var reachesSelf func(string) bool
		reachesSelf = func(name string) bool {
			for _, next := range edges[name] {
				if next == f.Name {
					return true
				}
				if visiting[next] {
					continue
				}
				visiting[next] = true
				if reachesSelf(next) {
					return true
				}
			}
			return false
		}
		visiting[f.Name] = true
		result[f.Name] = reachesSelf(f.Name)
	}
	return result
}

func coreCInstruction(f Function, ins Instruction, names map[string]string) (string, error) {
	dest := ""
	if ins.Dest >= 0 {
		dest = fmt.Sprintf("s%d=", ins.Dest)
	}
	loc := coreCQuote(formatLocation(ins.Location))
	arg := func(i int) string { return fmt.Sprintf("s%d", ins.Args[i]) }
	typ := Void
	if ins.Dest >= 0 {
		typ = f.Slots[ins.Dest]
	}
	switch ins.Op {
	case "const":
		literal, err := coreCLiteral(*ins.Constant)
		if err != nil {
			return "", err
		}
		return dest + literal + ";", nil
	case "move":
		return dest + arg(0) + ";", nil
	case "call":
		args := make([]string, len(ins.Args))
		for i := range args {
			args[i] = arg(i)
		}
		return fmt.Sprintf("%s%s(%s);", dest, names[ins.Callee], strings.Join(args, ",")), nil
	case "bytes.from_storage_u64":
		return fmt.Sprintf("%sswyp_bytes_snapshot(%s,%s,%s);", dest, arg(0), arg(1), loc), nil
	case "bytes.len":
		return fmt.Sprintf("%sswyp_bytes_len(%s,%s);", dest, arg(0), loc), nil
	case "bytes.get":
		return fmt.Sprintf("%sswyp_bytes_get(%s,%s,%s);", dest, arg(0), arg(1), loc), nil
	case "storage.alloc_u64":
		return fmt.Sprintf("%sswyp_storage_alloc(%s,%s);", dest, arg(0), loc), nil
	case "storage.load_u64":
		return fmt.Sprintf("%sswyp_storage_load(%s,%s,%s);", dest, arg(0), arg(1), loc), nil
	case "storage.store_u64":
		return fmt.Sprintf("swyp_storage_store(%s,%s,%s,%s);", arg(0), arg(1), arg(2), loc), nil
	case "storage.free":
		return fmt.Sprintf("swyp_storage_free(%s,%s);", arg(0), loc), nil
	case "storage.len_u64":
		return fmt.Sprintf("%sswyp_storage_block(%s,%s)->length;", dest, arg(0), loc), nil
	case "storage.capacity_u64":
		return fmt.Sprintf("%sswyp_storage_block(%s,%s)->capacity;", dest, arg(0), loc), nil
	case "storage.set_len_u64":
		return fmt.Sprintf("swyp_storage_set_len(%s,%s,%s);", arg(0), arg(1), loc), nil
	case "not":
		return dest + "!" + arg(0) + ";", nil
	case "neg":
		if typ == I64 {
			return fmt.Sprintf("%sswyp_i64_neg(%s,%s);", dest, arg(0), loc), nil
		}
		if typ == U64 {
			return fmt.Sprintf("%sUINT64_C(0)-%s;", dest, arg(0)), nil
		}
		return dest + "-" + arg(0) + ";", nil
	case "eq", "ne":
		a, bt := f.Slots[ins.Args[0]], f.Slots[ins.Args[1]]
		if a != bt {
			if ins.Op == "eq" {
				return dest + "false;", nil
			}
			return dest + "true;", nil
		}
		op := "=="
		if ins.Op == "ne" {
			op = "!="
		}
		return fmt.Sprintf("%s%s%s%s;", dest, arg(0), op, arg(1)), nil
	case "lt", "le", "gt", "ge":
		op := map[string]string{"lt": "<", "le": "<=", "gt": ">", "ge": ">="}[ins.Op]
		return fmt.Sprintf("%s%s%s%s;", dest, arg(0), op, arg(1)), nil
	case "add", "sub", "mul", "div", "rem":
		if typ == I64 {
			return fmt.Sprintf("%sswyp_i64_%s(%s,%s,%s);", dest, ins.Op, arg(0), arg(1), loc), nil
		}
		if typ == U64 {
			switch ins.Op {
			case "add":
				return fmt.Sprintf("%s%s+%s;", dest, arg(0), arg(1)), nil
			case "sub":
				return fmt.Sprintf("%s%s-%s;", dest, arg(0), arg(1)), nil
			case "mul":
				return fmt.Sprintf("%s%s*%s;", dest, arg(0), arg(1)), nil
			case "div":
				return fmt.Sprintf("%sswyp_u64_div(%s,%s,%s);", dest, arg(0), arg(1), loc), nil
			case "rem":
				return fmt.Sprintf("%sswyp_u64_rem(%s,%s,%s);", dest, arg(0), arg(1), loc), nil
			}
		}
		if typ == IEEE64 {
			switch ins.Op {
			case "add":
				return fmt.Sprintf("%s%s+%s;", dest, arg(0), arg(1)), nil
			case "sub":
				return fmt.Sprintf("%s%s-%s;", dest, arg(0), arg(1)), nil
			case "mul":
				return fmt.Sprintf("%s%s*%s;", dest, arg(0), arg(1)), nil
			case "div":
				return fmt.Sprintf("%s%s/%s;", dest, arg(0), arg(1)), nil
			case "rem":
				return fmt.Sprintf("%sfmod(%s,%s);", dest, arg(0), arg(1)), nil
			}
		}
		return fmt.Sprintf("%sswyp_f64_%s(%s,%s,%s);", dest, ins.Op, arg(0), arg(1), loc), nil
	case "band":
		return fmt.Sprintf("%s%s&%s;", dest, arg(0), arg(1)), nil
	case "bor":
		return fmt.Sprintf("%s%s|%s;", dest, arg(0), arg(1)), nil
	case "bxor":
		return fmt.Sprintf("%s%s^%s;", dest, arg(0), arg(1)), nil
	case "shl":
		return fmt.Sprintf("%sswyp_u64_shl(%s,%s,%s);", dest, arg(0), arg(1), loc), nil
	case "shr":
		return fmt.Sprintf("%sswyp_u64_shr(%s,%s,%s);", dest, arg(0), arg(1), loc), nil
	default:
		return "", diagnostic("invalid_opcode", ins.Op)
	}
}

func emitCoreTerminator(b *bytes.Buffer, f Function, t Terminator, block int, profile NativeProfile) error {
	switch t.Op {
	case "return":
		fmt.Fprintln(b, "swyp_leave_call();")
		if t.Value < 0 {
			fmt.Fprintln(b, "return;")
		} else {
			fmt.Fprintf(b, "return s%d;\n", t.Value)
		}
	case "jump":
		if profile == NativeFast && t.Targets[0] <= block {
			fmt.Fprintln(b, "swyp_tick();")
		}
		fmt.Fprintf(b, "goto b%d;\n", t.Targets[0])
	case "branch":
		if profile == NativeFast {
			fmt.Fprintf(b, "if(s%d){", t.Value)
			if t.Targets[0] <= block {
				fmt.Fprint(b, "swyp_tick();")
			}
			fmt.Fprintf(b, "goto b%d;}else{", t.Targets[0])
			if t.Targets[1] <= block {
				fmt.Fprint(b, "swyp_tick();")
			}
			fmt.Fprintf(b, "goto b%d;}\n", t.Targets[1])
		} else {
			fmt.Fprintf(b, "if(s%d) goto b%d; else goto b%d;\n", t.Value, t.Targets[0], t.Targets[1])
		}
	case "unreachable":
		fmt.Fprintf(b, "swyp_fail(%s,\"unreachable\");\n", coreCQuote(formatLocation(t.Location)))
		if f.Result != Void {
			fmt.Fprintf(b, "return (%s)0;\n", coreCType(f.Result))
		} else {
			fmt.Fprintln(b, "return;")
		}
	default:
		return diagnostic("invalid_ir", "unknown terminator")
	}
	return nil
}

func coreCLiteral(l Literal) (string, error) {
	v, err := ParseValue(l.Type, l.Value)
	if err != nil {
		return "", err
	}
	switch l.Type {
	case I64:
		x, _ := v.Int64()
		if x == -1<<63 {
			return "INT64_MIN", nil
		}
		return fmt.Sprintf("INT64_C(%d)", x), nil
	case U64:
		x, _ := v.Uint64()
		return fmt.Sprintf("UINT64_C(%d)", x), nil
	case Bytes:
		return fmt.Sprintf("UINT64_C(%d)", v.u), nil
	case F64, IEEE64:
		x, _ := v.Float64()
		if math.IsNaN(x) {
			return "NAN", nil
		}
		if math.IsInf(x, 1) {
			return "INFINITY", nil
		}
		if math.IsInf(x, -1) {
			return "-INFINITY", nil
		}
		return strconv.FormatFloat(x, 'x', -1, 64), nil
	case Bool:
		x, _ := v.Boolean()
		return strconv.FormatBool(x), nil
	default:
		return "", diagnostic("invalid_literal", "unsupported native literal")
	}
}

func formatLocation(l Location) string {
	if l.Line == 0 {
		return "<core>"
	}
	return fmt.Sprintf("%s:%d:%d", l.File, l.Line, l.Column)
}

func coreCQuote(s string) string {
	return strconv.QuoteToASCII(s)
}

func emitCoreMain(b *bytes.Buffer, root Function, name string) {
	fmt.Fprintln(b, "int main(int argc,char **argv){")
	fmt.Fprintf(b, "if(argc!=%d) swyp_fail(\"<cli>\",\"incorrect argument count\");\n", len(root.Params)+1)
	fmt.Fprintln(b, "swyp_init_steps();")
	args := make([]string, len(root.Params))
	for i, p := range root.Params {
		args[i] = fmt.Sprintf("a%d", i)
		fmt.Fprintf(b, "%s %s=%s(argv[%d],\"<arg%d>\");\n", coreCType(p.Type), args[i], coreCParseFunc(p.Type), i+1, i)
	}
	call := fmt.Sprintf("%s(%s)", name, strings.Join(args, ","))
	switch root.Result {
	case Void:
		fmt.Fprintf(b, "%s; return 0;\n", call)
	case I64:
		fmt.Fprintf(b, "int64_t result=%s; printf(\"%%\" PRId64 \"\\n\",result); return 0;\n", call)
	case U64, Bytes:
		fmt.Fprintf(b, "uint64_t result=%s; printf(\"%%\" PRIu64 \"\\n\",result); return 0;\n", call)
	case F64, IEEE64:
		fmt.Fprintf(b, "double result=%s; printf(\"%%.17g\\n\",result); return 0;\n", call)
	case Bool:
		fmt.Fprintf(b, "bool result=%s; fputs(result?\"true\\n\":\"false\\n\",stdout); return 0;\n", call)
	}
	fmt.Fprintln(b, "}")
}

func coreCParseFunc(t Type) string {
	switch t {
	case I64:
		return "swyp_parse_i64"
	case U64:
		return "swyp_parse_u64"
	case F64:
		return "swyp_parse_f64"
	case IEEE64:
		return "swyp_parse_ieee64"
	case Bool:
		return "swyp_parse_bool"
	default:
		panic("void parameter passed validation")
	}
}

const coreNativeRuntime = `/* Generated by Swyp Semantic Core AOT. C11, no fast-math. */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <inttypes.h>
#include <stdbool.h>
#include <limits.h>
#include <math.h>
#include <errno.h>
#include <string.h>

#if defined(__GNUC__) || defined(__clang__)
#define SWYP_INLINE static inline __attribute__((always_inline))
#define SWYP_COLD __attribute__((cold,noinline))
#define SWYP_UNLIKELY(x) __builtin_expect(!!(x),0)
#else
#define SWYP_INLINE static inline
#define SWYP_COLD
#define SWYP_UNLIKELY(x) (x)
#endif

#define SWYP_STR_IMPL(x) #x
#define SWYP_STR(x) SWYP_STR_IMPL(x)

static uint64_t swyp_steps=1000000000ULL;
static SWYP_COLD void swyp_fail(const char *pos,const char *message){fprintf(stderr,"%s: %s\n",pos,message);exit(1);}
static void swyp_init_steps(void){const char *s=getenv("SWYP_CORE_STEPS");if(!s||!*s)return;char *e=NULL;errno=0;unsigned long long v=strtoull(s,&e,10);if(errno||e==s||*e||v==0)swyp_fail("<fuel>","invalid SWYP_CORE_STEPS");swyp_steps=(uint64_t)v;}
SWYP_INLINE void swyp_tick(void){if(SWYP_UNLIKELY(!swyp_steps))swyp_fail("<fuel>","execution step limit exceeded");--swyp_steps;}

static uint64_t swyp_call_depth=0;
SWYP_INLINE void swyp_enter_call(void){if(SWYP_UNLIKELY(++swyp_call_depth>SWYP_MAX_CALL_DEPTH))swyp_fail("call_depth","call depth exceeds " SWYP_STR(SWYP_MAX_CALL_DEPTH));}
SWYP_INLINE void swyp_leave_call(void){--swyp_call_depth;}

static int64_t swyp_parse_i64(const char *s,const char *pos){char *e=NULL;errno=0;long long v=strtoll(s,&e,10);if(errno||e==s||*e)swyp_fail(pos,"invalid i64 argument");return(int64_t)v;}
static uint64_t swyp_parse_u64(const char *s,const char *pos){if(*s<'0'||*s>'9')swyp_fail(pos,"invalid u64 argument");char *e=NULL;errno=0;unsigned long long v=strtoull(s,&e,10);if(errno||e==s||*e)swyp_fail(pos,"invalid u64 argument");return(uint64_t)v;}
static double swyp_parse_f64(const char *s,const char *pos){char *e=NULL;errno=0;double v=strtod(s,&e);if(errno||e==s||*e||!isfinite(v))swyp_fail(pos,"invalid finite f64 argument");return v;}
static double swyp_parse_ieee64(const char *s,const char *pos){char *e=NULL;errno=0;double v=strtod(s,&e);if(errno||e==s||*e)swyp_fail(pos,"invalid ieee64 argument");return v;}
static bool swyp_parse_bool(const char *s,const char *pos){if(strcmp(s,"true")==0)return true;if(strcmp(s,"false")==0)return false;swyp_fail(pos,"invalid bool argument");return false;}

SWYP_INLINE int64_t swyp_i64_add(int64_t a,int64_t b,const char *p){
#if defined(__GNUC__) || defined(__clang__)
 int64_t r;if(SWYP_UNLIKELY(__builtin_add_overflow(a,b,&r)))swyp_fail(p,"i64 add overflow");return r;
#else
 if((b>0&&a>INT64_MAX-b)||(b<0&&a<INT64_MIN-b))swyp_fail(p,"i64 add overflow");return a+b;
#endif
}
SWYP_INLINE int64_t swyp_i64_sub(int64_t a,int64_t b,const char *p){
#if defined(__GNUC__) || defined(__clang__)
 int64_t r;if(SWYP_UNLIKELY(__builtin_sub_overflow(a,b,&r)))swyp_fail(p,"i64 sub overflow");return r;
#else
 if((b>0&&a<INT64_MIN+b)||(b<0&&a>INT64_MAX+b))swyp_fail(p,"i64 sub overflow");return a-b;
#endif
}
SWYP_INLINE int64_t swyp_i64_mul(int64_t a,int64_t b,const char *p){
#if defined(__GNUC__) || defined(__clang__)
 int64_t r;if(SWYP_UNLIKELY(__builtin_mul_overflow(a,b,&r)))swyp_fail(p,"i64 mul overflow");return r;
#else
 if(a==0||b==0)return 0;
 if((a==INT64_MIN&&b==-1)||(b==INT64_MIN&&a==-1))swyp_fail(p,"i64 mul overflow");
 if(a>0){if(b>0){if(a>INT64_MAX/b)swyp_fail(p,"i64 mul overflow");}else{if(b<INT64_MIN/a)swyp_fail(p,"i64 mul overflow");}}
 else{if(b>0){if(a<INT64_MIN/b)swyp_fail(p,"i64 mul overflow");}else{if(a!=0&&b<INT64_MAX/a)swyp_fail(p,"i64 mul overflow");}}
 return a*b;
#endif
}
SWYP_INLINE int64_t swyp_i64_div(int64_t a,int64_t b,const char *p){if(SWYP_UNLIKELY(!b))swyp_fail(p,"division by zero");if(SWYP_UNLIKELY(a==INT64_MIN&&b==-1))swyp_fail(p,"i64 div overflow");return a/b;}
SWYP_INLINE int64_t swyp_i64_rem(int64_t a,int64_t b,const char *p){if(SWYP_UNLIKELY(!b))swyp_fail(p,"division by zero");if(a==INT64_MIN&&b==-1)return 0;return a%b;}
SWYP_INLINE int64_t swyp_i64_neg(int64_t a,const char *p){if(SWYP_UNLIKELY(a==INT64_MIN))swyp_fail(p,"i64 negation overflow");return-a;}
SWYP_INLINE uint64_t swyp_u64_div(uint64_t a,uint64_t b,const char *p){if(SWYP_UNLIKELY(!b))swyp_fail(p,"division by zero");return a/b;}
SWYP_INLINE uint64_t swyp_u64_rem(uint64_t a,uint64_t b,const char *p){if(SWYP_UNLIKELY(!b))swyp_fail(p,"division by zero");return a%b;}
SWYP_INLINE uint64_t swyp_u64_shl(uint64_t a,uint64_t b,const char *p){if(SWYP_UNLIKELY(b>=64))swyp_fail(p,"u64 shift count must be below 64");return a<<b;}
SWYP_INLINE uint64_t swyp_u64_shr(uint64_t a,uint64_t b,const char *p){if(SWYP_UNLIKELY(b>=64))swyp_fail(p,"u64 shift count must be below 64");return a>>b;}

SWYP_INLINE double swyp_f64_checked(double x,const char *p){if(SWYP_UNLIKELY(!isfinite(x)))swyp_fail(p,"non-finite f64 result");return x;}
SWYP_INLINE double swyp_f64_add(double a,double b,const char *p){return swyp_f64_checked(a+b,p);}
SWYP_INLINE double swyp_f64_sub(double a,double b,const char *p){return swyp_f64_checked(a-b,p);}
SWYP_INLINE double swyp_f64_mul(double a,double b,const char *p){return swyp_f64_checked(a*b,p);}
SWYP_INLINE double swyp_f64_div(double a,double b,const char *p){if(SWYP_UNLIKELY(b==0))swyp_fail(p,"division by zero");return swyp_f64_checked(a/b,p);}
SWYP_INLINE double swyp_f64_rem(double a,double b,const char *p){if(SWYP_UNLIKELY(b==0))swyp_fail(p,"division by zero");return swyp_f64_checked(fmod(a,b),p);}

`

const coreNativeStorageRuntime = `
typedef struct {uint64_t *data,capacity,length;bool live;} swyp_storage;
static swyp_storage swyp_storage_blocks[SWYP_STORAGE_BLOCKS];
static uint64_t swyp_storage_next=1,swyp_storage_used=0,swyp_byte_cursor=SWYP_MODULE_BYTES;
static swyp_storage *swyp_storage_block(uint64_t id,const char *p){
 if(!id||id>=swyp_storage_next||!swyp_storage_blocks[id-1].live)swyp_fail(p,"storage");
 return &swyp_storage_blocks[id-1];
}
static uint64_t swyp_storage_alloc(uint64_t n,const char *p){
 if(n>UINT64_MAX/8)swyp_fail(p,"storage_limit");
 if(swyp_storage_next>SWYP_STORAGE_BLOCKS||n*8>SWYP_STORAGE_BYTES-swyp_storage_used)swyp_fail(p,"storage");
 uint64_t *data=calloc(n?n:1,sizeof(uint64_t));if(!data)swyp_fail(p,"storage");
 uint64_t id=swyp_storage_next++;swyp_storage_blocks[id-1]=(swyp_storage){data,n,n,true};swyp_storage_used+=n*8;return id;
}
static uint64_t swyp_storage_load(uint64_t id,uint64_t i,const char *p){
 swyp_storage *s=swyp_storage_block(id,p);if(i>=s->capacity)swyp_fail(p,"bounds");return s->data[i];
}
static void swyp_storage_store(uint64_t id,uint64_t i,uint64_t v,const char *p){
 swyp_storage *s=swyp_storage_block(id,p);if(i>=s->capacity)swyp_fail(p,"bounds");s->data[i]=v;
}
static void swyp_storage_free(uint64_t id,const char *p){
 swyp_storage *s=swyp_storage_block(id,p);swyp_storage_used-=s->capacity*8;free(s->data);s->data=NULL;s->live=false;
}
static void swyp_storage_set_len(uint64_t id,uint64_t n,const char *p){
 if(n>UINT64_MAX/8)swyp_fail(p,"storage_limit");
 swyp_storage *s=swyp_storage_block(id,p);if(n>s->capacity)swyp_fail(p,"storage");s->length=n;
}
static uint64_t swyp_bytes_len(uint64_t span,const char *p){
 uint64_t o=span>>32,n=(uint32_t)span;if(o>swyp_byte_cursor||n>swyp_byte_cursor-o)swyp_fail(p,"invalid_bytespan");return n;
}
static uint64_t swyp_bytes_get(uint64_t span,uint64_t i,const char *p){
 uint64_t n=swyp_bytes_len(span,p);if(i>=n)swyp_fail(p,"bounds");return swyp_byte_data[(span>>32)+i];
}
static uint64_t swyp_bytes_snapshot(uint64_t id,uint64_t n,const char *p){
 swyp_storage *s=swyp_storage_block(id,p);
 if(n>UINT64_MAX/8)swyp_fail(p,"storage_limit");
 if(n>s->capacity)swyp_fail(p,"bounds");
 if(n>SWYP_RUN_BYTES-(swyp_byte_cursor-SWYP_MODULE_BYTES))swyp_fail(p,"byte_arena_exhausted");
 for(uint64_t i=0;i<n;i++)if(s->data[i]>255)swyp_fail(p,"invalid_octet");
 uint64_t start=swyp_byte_cursor;
 for(uint64_t i=0;i<n;i++)swyp_byte_data[start+i]=(unsigned char)s->data[i];
 swyp_byte_cursor+=n;return(start<<32)|n;
}
`
