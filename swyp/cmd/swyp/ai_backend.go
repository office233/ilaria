package main

import (
	"os"
	"strings"

	"swyp-lang/internal/ilaria"
)

const defaultIlariaEndpoint = "http://127.0.0.1:8091"

func configuredIlariaBackend() (ilaria.Backend, string) {
	endpoint := strings.TrimSpace(os.Getenv("SWYP_ILARIA_ENDPOINT"))
	if endpoint == "" {
		endpoint = defaultIlariaEndpoint
	}
	token := os.Getenv("SWYP_ILARIA_TOKEN")
	if strings.TrimSpace(token) != "" {
		return ilaria.NewCloudBackend(endpoint, token), "Ilaria configured authenticated endpoint"
	}
	if endpoint == defaultIlariaEndpoint {
		return ilaria.NewLocalBackend(endpoint), "Ilaria loopback; model/checkpoint identity not reported"
	}
	return ilaria.NewLocalBackend(endpoint), "Ilaria configured endpoint; model/checkpoint identity not reported"
}
