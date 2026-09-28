package moderation

import (
	"context"
	"time"
)

type CaseStatus string

const (
	CaseOpen     CaseStatus = "open"
	CaseReview   CaseStatus = "in_review"
	CaseResolved CaseStatus = "resolved"
)

type Case struct {
	ID          string     `json:"id"`
	SubjectID   string     `json:"subject_id"`
	SubjectType string     `json:"subject_type"`
	Reason      string     `json:"reason"`
	Status      CaseStatus `json:"status"`
	Priority    string     `json:"priority"`
	CreatedAt   time.Time  `json:"created_at"`
}

type Service struct {
	cases []Case
}

func NewService(cases []Case) *Service {
	if cases == nil {
		cases = DefaultCases()
	}
	return &Service{cases: append([]Case(nil), cases...)}
}

func (s *Service) ListCases(_ context.Context) ([]Case, error) {
	return append([]Case(nil), s.cases...), nil
}

func DefaultCases() []Case {
	return []Case{
		{
			ID:          "mod_case_seed_1",
			SubjectID:   "video_seed_1",
			SubjectType: "video",
			Reason:      "awaiting first human review",
			Status:      CaseOpen,
			Priority:    "normal",
			CreatedAt:   time.Now().UTC(),
		},
	}
}
