package coreir

type processDataTarget uint8

const (
	processDataModule processDataTarget = iota
	processDataRuntime
)
