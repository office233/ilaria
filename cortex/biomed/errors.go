package biomed

import "errors"

var (
	// ErrNotFound: the source answered but has no record for the query.
	ErrNotFound = errors.New("biomed: not found")
	// ErrOffline: the source could not be reached and no cached copy exists.
	ErrOffline = errors.New("biomed: source unreachable and not cached")
	// ErrInsufficientPK: the label did not yield the parameters a simulation needs.
	ErrInsufficientPK = errors.New("biomed: insufficient pharmacokinetic data")
	// ErrDisallowedHost: the URL is not on the allow-list; no request was made.
	ErrDisallowedHost = errors.New("biomed: host not allowed")
)
