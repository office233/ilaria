//go:build !windows

package hal

import (
 "fmt"
 "math"
)

// Linux uses kernel drivers. This compatibility adapter does not claim CUDA
// support until an actual Linux CUDA/NVML adapter is implemented.
type CUDATelemetry struct {
 DeviceName string `json:"device_name"`
 TotalVRAMMB int `json:"total_vram_mb"`
 FreeVRAMMB int `json:"free_vram_mb"`
 UsedVRAMMB int `json:"used_vram_mb"`
 TemperatureC uint32 `json:"temperature_c"`
 PowerWatts float64 `json:"power_watts"`
 IsHardwareLive bool `json:"is_hardware_live"`
}
type CUDADriver struct{}
func NewCUDADriver()*CUDADriver{return &CUDADriver{}}
func(*CUDADriver)Init()error{return nil}
func(*CUDADriver)GetMemoryInfo()(int,int,error){return 0,0,fmt.Errorf("Linux GPU telemetry is not implemented")}
func(*CUDADriver)GetTelemetry()(*CUDATelemetry,error){return &CUDATelemetry{DeviceName:"GPU telemetry unavailable on this platform"},nil}
// Legacy CPU reference calculation; this is NOT a GPU kernel.
func(*CUDADriver)ExecuteTensorsMicroKernel(w,x []float32)([]float32,error){
 if len(w)!=len(x){return nil,fmt.Errorf("dimension mismatch")};out:=make([]float32,len(w));for i:=range w{v:=float64(w[i]*x[i]);out[i]=float32(v/(1+math.Exp(-v)))};return out,nil
}
