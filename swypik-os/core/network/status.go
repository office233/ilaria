// Package network inventories interfaces without external probes or changes.
package network

import (
	"context"
	"net"
	"runtime"
	"sort"
	"time"
)

type Interface struct {
	Index                int      `json:"index"`
	Name                 string   `json:"name"`
	Up                   bool     `json:"up"`
	Loopback             bool     `json:"loopback"`
	Addresses            []string `json:"addresses"`
	AddressesUnavailable bool     `json:"addresses_unavailable,omitempty"`
}
type Status struct {
	HostOS           string      `json:"host_os"`
	DriverOwner      string      `json:"driver_owner"`
	Internet         string      `json:"internet"`
	HasActiveAdapter bool        `json:"has_active_adapter"`
	Interfaces       []Interface `json:"interfaces"`
	Truncated        bool        `json:"truncated"`
	ObservedAt       time.Time   `json:"observed_at"`
}

// An UP adapter does not prove DNS, TLS or Internet connectivity.
func Inspect(ctx context.Context) (Status, error) {
	return inspect(ctx, net.Interfaces, func(i net.Interface) ([]net.Addr, error) { return i.Addrs() })
}
func inspect(ctx context.Context, list func() ([]net.Interface, error), addresses func(net.Interface) ([]net.Addr, error)) (Status, error) {
	s := Status{HostOS: runtime.GOOS, DriverOwner: "host_operating_system", Internet: "not_tested", Interfaces: []Interface{}, ObservedAt: time.Now().UTC()}
	if runtime.GOOS == "linux" {
		s.DriverOwner = "linux_kernel"
	}
	if err := ctx.Err(); err != nil {
		return s, err
	}
	items, err := list()
	if err != nil {
		return s, err
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Index < items[j].Index })
	if len(items) > 32 {
		items = items[:32]
		s.Truncated = true
	}
	for _, item := range items {
		if err := ctx.Err(); err != nil {
			return s, err
		}
		out := Interface{Index: item.Index, Name: item.Name, Up: item.Flags&net.FlagUp != 0, Loopback: item.Flags&net.FlagLoopback != 0, Addresses: []string{}}
		addrs, err := addresses(item)
		out.AddressesUnavailable = err != nil
		if len(addrs) > 4 {
			addrs = addrs[:4]
			s.Truncated = true
		}
		for _, a := range addrs {
			out.Addresses = append(out.Addresses, a.String())
		}
		if out.Up && !out.Loopback {
			s.HasActiveAdapter = true
		}
		s.Interfaces = append(s.Interfaces, out)
	}
	return s, ctx.Err()
}
