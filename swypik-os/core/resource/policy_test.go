package resource

import (
	"runtime"
	"runtime/debug"
	"testing"
	"time"
)

func TestProfilesStayBoundedAndConservative(t *testing.T) {
	phone := ForProfile(ProfilePhone)
	balanced := ForProfile(ProfileBalanced)
	performance := ForProfile(ProfilePerformance)

	for _, p := range []Policy{phone, balanced, performance} {
		if p.MaxBackgroundCPUPercent <= 0 || p.MaxBackgroundCPUPercent > 25 {
			t.Fatalf("%s CPU budget=%d", p.Profile, p.MaxBackgroundCPUPercent)
		}
		if p.MaxBackgroundGPUPercent <= 0 || p.MaxBackgroundGPUPercent > 50 {
			t.Fatalf("%s GPU budget=%d", p.Profile, p.MaxBackgroundGPUPercent)
		}
		if p.MaxBackgroundWorkers < 1 || p.MaxBackgroundWorkers > 4 {
			t.Fatalf("%s workers=%d", p.Profile, p.MaxBackgroundWorkers)
		}
		if p.StatusPollInterval < 2*time.Second {
			t.Fatalf("%s poll interval too aggressive: %s", p.Profile, p.StatusPollInterval)
		}
		if p.SearchMaxFiles < 1 || p.SearchMaxFiles > 20000 {
			t.Fatalf("%s search files=%d", p.Profile, p.SearchMaxFiles)
		}
		if p.SearchMaxDocuments < 1 || p.SearchMaxDocuments > 20000 {
			t.Fatalf("%s search docs=%d", p.Profile, p.SearchMaxDocuments)
		}
		if p.SearchMaxTextBytes < 1024 || p.SearchMaxTextBytes > 16384 {
			t.Fatalf("%s search text bytes=%d", p.Profile, p.SearchMaxTextBytes)
		}
		if p.MaxGraphCheckpoints < 4 || p.MaxGraphCheckpoints > 32 {
			t.Fatalf("%s graph checkpoints=%d", p.Profile, p.MaxGraphCheckpoints)
		}
		if p.MemoryLimitMB < 128 || p.MemoryLimitMB > 1024 {
			t.Fatalf("%s memory limit=%d MB", p.Profile, p.MemoryLimitMB)
		}
		if p.GCPercent < 50 || p.GCPercent > 200 {
			t.Fatalf("%s GC percent=%d", p.Profile, p.GCPercent)
		}
		if p.MaxTrainingDeltaParams < 1024 || p.MaxTrainingDeltaParams > 1_000_000 {
			t.Fatalf("%s training delta params=%d", p.Profile, p.MaxTrainingDeltaParams)
		}
		if p.MaxPendingDeltas < 8 || p.MaxPendingDeltas > 512 {
			t.Fatalf("%s pending deltas=%d", p.Profile, p.MaxPendingDeltas)
		}
		if p.MaxChatHistoryMessages < 20 || p.MaxChatHistoryMessages > 100 {
			t.Fatalf("%s chat history=%d", p.Profile, p.MaxChatHistoryMessages)
		}
		if p.MaxDocumentBytes < 64<<10 || p.MaxDocumentBytes > 4<<20 {
			t.Fatalf("%s document bytes=%d", p.Profile, p.MaxDocumentBytes)
		}
		if p.MaxAppCatalogEntries < 16 || p.MaxAppCatalogEntries > 1024 {
			t.Fatalf("%s app catalog=%d", p.Profile, p.MaxAppCatalogEntries)
		}
		if p.MaxResidentPeers < 16 || p.MaxResidentPeers > 2048 {
			t.Fatalf("%s resident peers=%d", p.Profile, p.MaxResidentPeers)
		}
		if p.MaxHiveTasks < 16 || p.MaxHiveTasks > 500 {
			t.Fatalf("%s hive tasks=%d", p.Profile, p.MaxHiveTasks)
		}
		if p.P2PInspectionQueue < 4 || p.P2PInspectionQueue > 32 {
			t.Fatalf("%s P2P inspection queue=%d", p.Profile, p.P2PInspectionQueue)
		}
		if p.P2PInspectionPayloadMax < 1024 || p.P2PInspectionPayloadMax > 64<<10 {
			t.Fatalf("%s P2P inspection payload=%d", p.Profile, p.P2PInspectionPayloadMax)
		}
	}
	if phone.MaxBackgroundCPUPercent >= balanced.MaxBackgroundCPUPercent ||
		balanced.MaxBackgroundCPUPercent >= performance.MaxBackgroundCPUPercent {
		t.Fatal("CPU budgets must increase monotonically by profile")
	}
}

func TestApplyRuntimeNeverRelaxesStricterLimits(t *testing.T) {
	originalProcs := runtime.GOMAXPROCS(0)
	originalLimit := debug.SetMemoryLimit(24 << 20)
	originalGC := debug.SetGCPercent(50)
	defer runtime.GOMAXPROCS(originalProcs)
	defer debug.SetMemoryLimit(originalLimit)
	defer debug.SetGCPercent(originalGC)

	ApplyRuntime(ForProfile(ProfileBalanced))
	if got := debug.SetMemoryLimit(-1); got != 24<<20 {
		t.Fatalf("memory limit=%d want %d", got, int64(24<<20))
	}
	currentGC := debug.SetGCPercent(999)
	debug.SetGCPercent(currentGC)
	if currentGC != 50 {
		t.Fatalf("GOGC=%d want 50", currentGC)
	}
}

func TestApplyRuntimeCapsSchedulerByProfile(t *testing.T) {
	original := runtime.GOMAXPROCS(0)
	originalLimit := debug.SetMemoryLimit(-1)
	originalGC := debug.SetGCPercent(100)
	defer runtime.GOMAXPROCS(original)
	defer debug.SetMemoryLimit(originalLimit)
	defer debug.SetGCPercent(originalGC)

	ApplyRuntime(ForProfile(ProfilePhone))
	if got := runtime.GOMAXPROCS(0); got > 1 {
		t.Fatalf("phone GOMAXPROCS=%d want <=1", got)
	}
	ApplyRuntime(ForProfile(ProfileBalanced))
	if got := runtime.GOMAXPROCS(0); got > 2 {
		t.Fatalf("balanced GOMAXPROCS=%d want <=2", got)
	}
}

func TestProfilesBoundResidentStateAggressively(t *testing.T) {
	phone := ForProfile(ProfilePhone)
	balanced := ForProfile(ProfileBalanced)
	if phone.MaxResidentPeers > 16 || phone.MaxHiveTasks > 16 || phone.MaxPendingDeltas > 16 {
		t.Fatalf("phone resident state too large: %+v", phone)
	}
	if balanced.MaxResidentPeers > 128 || balanced.MaxHiveTasks > 128 || balanced.MaxPendingDeltas > 64 {
		t.Fatalf("balanced resident state too large: %+v", balanced)
	}
	if phone.MemoryLimitMB >= balanced.MemoryLimitMB {
		t.Fatalf("phone memory=%d balanced=%d", phone.MemoryLimitMB, balanced.MemoryLimitMB)
	}
}

func TestDefaultUnknownProfileIsBalanced(t *testing.T) {
	t.Setenv("SWYPIK_RESOURCE_PROFILE", "unknown")
	if got := Default().Profile; got != ProfileBalanced {
		t.Fatalf("profile=%q want balanced", got)
	}
	t.Setenv("SWYPIK_RESOURCE_PROFILE", "phone")
	if got := Default().Profile; got != ProfilePhone {
		t.Fatalf("profile=%q want phone", got)
	}
}

func TestPolicyContractMatchesRuntimePolicy(t *testing.T) {
	p := ForProfile(ProfilePhone)
	c := p.Contract()
	if c.Profile != "phone" ||
		c.MaxBackgroundWorkers != 1 ||
		c.MemoryLimitMB != uint64(p.MemoryLimitMB) ||
		c.GCPercent != uint64(p.GCPercent) ||
		c.StatusPollMS != uint64(p.StatusPollInterval/time.Millisecond) {
		t.Fatalf("contract=%+v policy=%+v", c, p)
	}
}
