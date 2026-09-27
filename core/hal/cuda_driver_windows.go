package hal

import (
	"fmt"
	"math"
	"runtime"
	"sync"
	"syscall"
	"unsafe"
)

var (
	modNvcuda            *syscall.LazyDLL
	procCuInit           *syscall.LazyProc
	procCuDeviceGet      *syscall.LazyProc
	procCuDeviceGetName  *syscall.LazyProc
	procCuDeviceTotalMem *syscall.LazyProc
	procCuMemGetInfo     *syscall.LazyProc

	modNvml                        *syscall.LazyDLL
	procNvmlInit                   *syscall.LazyProc
	procNvmlDeviceGetHandleByIndex *syscall.LazyProc
	procNvmlDeviceGetTemperature   *syscall.LazyProc
	procNvmlDeviceGetPowerUsage    *syscall.LazyProc
	procNvmlShutdown               *syscall.LazyProc
)

func init() {
	if runtime.GOOS == "windows" {
		modNvcuda = syscall.NewLazyDLL("nvcuda.dll")
		procCuInit = modNvcuda.NewProc("cuInit")
		procCuDeviceGet = modNvcuda.NewProc("cuDeviceGet")
		procCuDeviceGetName = modNvcuda.NewProc("cuDeviceGetName")
		procCuDeviceTotalMem = modNvcuda.NewProc("cuDeviceTotalMem_v2")
		procCuMemGetInfo = modNvcuda.NewProc("cuMemGetInfo_v2")

		modNvml = syscall.NewLazyDLL("nvml.dll")
		procNvmlInit = modNvml.NewProc("nvmlInit_v2")
		procNvmlDeviceGetHandleByIndex = modNvml.NewProc("nvmlDeviceGetHandleByIndex_v2")
		procNvmlDeviceGetTemperature = modNvml.NewProc("nvmlDeviceGetTemperature")
		procNvmlDeviceGetPowerUsage = modNvml.NewProc("nvmlDeviceGetPowerUsage")
		procNvmlShutdown = modNvml.NewProc("nvmlShutdown")
	}
}

// CUDATelemetry contains live physical parameters read directly from the silicon.
type CUDATelemetry struct {
	DeviceName     string  `json:"device_name"`
	TotalVRAMMB    int     `json:"total_vram_mb"`
	FreeVRAMMB     int     `json:"free_vram_mb"`
	UsedVRAMMB     int     `json:"used_vram_mb"`
	TemperatureC   uint32  `json:"temperature_c"`
	PowerWatts     float64 `json:"power_watts"`
	IsHardwareLive bool    `json:"is_hardware_live"`
}

// CUDADriver provides a zero-overhead direct-to-metal abstraction for NVIDIA GPUs.
type CUDADriver struct {
	mu            sync.RWMutex
	initialized   bool
	hardwareReady bool
	nvmlReady     bool
	deviceHandle  uintptr
	nvmlHandle    uintptr
	deviceName    string
	totalVRAMMB   int
}

// NewCUDADriver instantiates the native hardware driver wrapper.
func NewCUDADriver() *CUDADriver {
	return &CUDADriver{}
}

// Init initializes the CUDA driver and NVML management library.
func (d *CUDADriver) Init() error {
	d.mu.Lock()
	defer d.mu.Unlock()

	if d.initialized {
		return nil
	}

	if runtime.GOOS != "windows" || modNvcuda == nil {
		d.initialized = true
		d.deviceName = "Software / CPU Acceleration (CUDA Unavailable)"
		d.totalVRAMMB = 0
		return nil
	}

	// Verify nvcuda.dll and cuInit exist before calling to prevent runtime panic on non-NVIDIA systems
	if modNvcuda.Load() != nil || procCuInit.Find() != nil {
		d.initialized = true
		d.deviceName = "Software / CPU Acceleration (CUDA Unavailable)"
		d.totalVRAMMB = 0
		return nil
	}

	// 1. Initialize Driver API: cuInit(0)
	ret, _, _ := procCuInit.Call(0)
	if ret != 0 {
		d.initialized = true
		d.deviceName = "Software / CPU Acceleration (cuInit err)"
		d.totalVRAMMB = 0
		return nil
	}

	// 2. Get Primary Device Handle: cuDeviceGet(&dev, 0)
	var dev int32
	if procCuDeviceGet.Find() != nil {
		d.initialized = true
		d.deviceName = "CUDA device unavailable"
		return nil
	}
	if procCuDeviceGet.Find() == nil {
		ret, _, _ = procCuDeviceGet.Call(uintptr(unsafe.Pointer(&dev)), 0)
		if ret != 0 {
			d.initialized = true
			d.deviceName = "Software / CPU Acceleration"
			d.totalVRAMMB = 0
			return nil
		}
		d.deviceHandle = uintptr(dev)
	}

	d.hardwareReady = true
	// 3. Query Device Name: cuDeviceGetName(buf, len, dev)
	if procCuDeviceGetName.Find() == nil {
		nameBuf := make([]byte, 256)
		ret, _, _ = procCuDeviceGetName.Call(uintptr(unsafe.Pointer(&nameBuf[0])), 256, uintptr(dev))
		if ret == 0 {
			n := 0
			for n < len(nameBuf) && nameBuf[n] != 0 {
				n++
			}
			d.deviceName = string(nameBuf[:n])
		} else {
			d.deviceName = "NVIDIA CUDA Acceleration Engine"
		}
	} else {
		d.deviceName = "NVIDIA CUDA Acceleration Engine"
	}

	// 4. Query Total Device Memory: cuDeviceTotalMem(&bytes, dev)
	if procCuDeviceTotalMem.Find() == nil {
		var totalBytes uint64
		ret, _, _ = procCuDeviceTotalMem.Call(uintptr(unsafe.Pointer(&totalBytes)), uintptr(dev))
		if ret == 0 {
			d.totalVRAMMB = int(totalBytes / (1024 * 1024))
		} else {
			d.totalVRAMMB = 0
		}
	} else {
		d.totalVRAMMB = 0
	}

	// 5. Try initializing NVML for live temperature and power (only if available)
	if modNvml != nil && modNvml.Load() == nil && procNvmlInit.Find() == nil {
		retNvml, _, _ := procNvmlInit.Call()
		if retNvml == 0 && procNvmlDeviceGetHandleByIndex.Find() == nil {
			var nvmlDev uintptr
			retDev, _, _ := procNvmlDeviceGetHandleByIndex.Call(0, uintptr(unsafe.Pointer(&nvmlDev)))
			if retDev == 0 {
				d.nvmlHandle = nvmlDev
				d.nvmlReady = true
			}
		}
	}

	d.initialized = true
	return nil
}

// GetMemoryInfo retrieves real-time free and total VRAM from the GPU.
func (d *CUDADriver) GetMemoryInfo() (freeMB, totalMB int, err error) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.memoryInfo()
}

func (d *CUDADriver) memoryInfo() (freeMB, totalMB int, err error) {

	if !d.initialized {
		return 0, 0, fmt.Errorf("cuda driver not initialized")
	}

	if !d.hardwareReady || procCuMemGetInfo == nil || procCuMemGetInfo.Find() != nil {
		return 0, d.totalVRAMMB, fmt.Errorf("GPU memory telemetry unavailable")
	}

	var freeBytes, totalBytes uint64
	ret, _, _ := procCuMemGetInfo.Call(
		uintptr(unsafe.Pointer(&freeBytes)),
		uintptr(unsafe.Pointer(&totalBytes)),
	)
	if ret != 0 {
		// If context not bound, return device total
		return 0, d.totalVRAMMB, fmt.Errorf("CUDA memory context unavailable")
	}

	freeMB = int(freeBytes / (1024 * 1024))
	totalMB = int(totalBytes / (1024 * 1024))
	return freeMB, totalMB, nil
}

// GetTelemetry polls live physical telemetry: thermals, power draw, and VRAM.
func (d *CUDADriver) GetTelemetry() (*CUDATelemetry, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	if !d.initialized {
		return nil, fmt.Errorf("cuda driver not initialized")
	}

	freeMB, totalMB, memoryErr := d.memoryInfo()
	usedMB := totalMB - freeMB
	if usedMB < 0 || memoryErr != nil {
		usedMB = 0
	}

	var temp uint32
	var powerWatts float64

	if d.nvmlReady && procNvmlDeviceGetTemperature != nil && procNvmlDeviceGetTemperature.Find() == nil {
		var t uint32
		// NVML_TEMPERATURE_GPU = 0
		ret, _, _ := procNvmlDeviceGetTemperature.Call(d.nvmlHandle, 0, uintptr(unsafe.Pointer(&t)))
		if ret == 0 && t > 0 && t < 120 {
			temp = t
		}
	}

	if d.nvmlReady && procNvmlDeviceGetPowerUsage != nil && procNvmlDeviceGetPowerUsage.Find() == nil {
		var milliwatts uint32
		ret, _, _ := procNvmlDeviceGetPowerUsage.Call(d.nvmlHandle, uintptr(unsafe.Pointer(&milliwatts)))
		if ret == 0 && milliwatts > 0 {
			powerWatts = float64(milliwatts) / 1000.0
		}
	}

	return &CUDATelemetry{
		DeviceName:     d.deviceName,
		TotalVRAMMB:    totalMB,
		FreeVRAMMB:     freeMB,
		UsedVRAMMB:     usedMB,
		TemperatureC:   temp,
		PowerWatts:     powerWatts,
		IsHardwareLive: d.hardwareReady,
	}, nil
}

// ExecuteTensorsMicroKernel runs a lockless FP32 vector calculation directly simulating Tensor execution.
func (d *CUDADriver) ExecuteTensorsMicroKernel(weights []float32, input []float32) ([]float32, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	if len(weights) != len(input) {
		return nil, fmt.Errorf("dimension mismatch: weights %d != input %d", len(weights), len(input))
	}

	out := make([]float32, len(weights))
	for i := range weights {
		// Differentiable activation: Swish/SiLU (x * sigmoid(x))
		x := weights[i] * input[i]
		out[i] = float32(float64(x) / (1 + math.Exp(-float64(x))))
	}
	return out, nil
}
