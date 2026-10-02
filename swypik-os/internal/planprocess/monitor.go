package planprocess

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// Monitor samples only during an explicitly marked activity. CPU is measured
// from this activity's baseline; RSS/peak RSS are observed process memory.
// The returned idempotent stop function performs the final bound check.
func (p *Process) Monitor(ctx context.Context, cpuLimit time.Duration, rssLimit uint64, interval time.Duration) func() error {
	if ctx == nil || cpuLimit < 0 || interval <= 0 {
		err := fmt.Errorf("process monitor requires context, nonnegative CPU limit and positive sample interval")
		p.fail(err)
		return func() error { return err }
	}
	p.mu.Lock()
	if p.monitorActive {
		p.mu.Unlock()
		return func() error { return ErrMonitorBusy }
	}
	p.monitorActive = true
	p.mu.Unlock()
	baseline, err := p.Usage()
	if err == nil {
		err = ctx.Err()
	}
	if err == nil && rssLimit > 0 && (baseline.RSSBytes > rssLimit || baseline.PeakRSSBytes > rssLimit) {
		err = ErrRSSLimit
	}
	if err != nil {
		p.fail(fmt.Errorf("process activity measurement: %w", err))
		p.mu.Lock()
		p.monitorActive = false
		p.mu.Unlock()
		return func() error { return err }
	}
	stop, done := make(chan struct{}), make(chan struct{})
	var once sync.Once
	var monitorErr error
	go func() {
		defer close(done)
		defer func() {
			p.mu.Lock()
			p.monitorActive = false
			p.mu.Unlock()
		}()
		check := func() error {
			if err := ctx.Err(); err != nil {
				return err
			}
			usage, err := p.Usage()
			if err != nil {
				return fmt.Errorf("process activity measurement: %w", err)
			}
			if cpuLimit > 0 && usage.CPUTime-baseline.CPUTime > cpuLimit {
				return ErrCPULimit
			}
			if rssLimit > 0 && (usage.RSSBytes > rssLimit || usage.PeakRSSBytes > rssLimit) {
				return ErrRSSLimit
			}
			return nil
		}
		finish := func(err error) {
			monitorErr = err
			if err != nil {
				p.fail(err)
			}
		}
		if err := ctx.Err(); err != nil {
			finish(err)
			return
		}
		if err := check(); err != nil {
			finish(err)
			return
		}
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				finish(ctx.Err())
				return
			case <-p.aborted:
				monitorErr = p.failureError()
				return
			case <-stop:
				finish(check())
				return
			case <-p.done:
				finish(check())
				return
			case <-ticker.C:
				if err := check(); err != nil {
					finish(err)
					return
				}
			}
		}
	}()
	return func() error {
		once.Do(func() { close(stop) })
		<-done
		return monitorErr
	}
}
