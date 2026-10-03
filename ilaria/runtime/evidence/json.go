package evidence

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"strconv"
	"strings"
	"unicode/utf8"
)

// MaxJSONBytes accommodates a 1 MiB decoded payload plus base64 and metadata.
const MaxJSONBytes = 2 << 20

// DecodeStrict enforces the v1 wire field names rather than encoding/json's
// case-insensitive aliases. It also rejects duplicates, trailing documents,
// invalid UTF-8/surrogates, noncanonical base64 and missing required fields.
func DecodeStrict(raw []byte, destination any) error {
	if len(raw) > MaxJSONBytes || !utf8.Valid(raw) {
		return fmt.Errorf("evidence: JSON exceeds size bound or contains invalid UTF-8")
	}
	if err := validateSurrogates(raw); err != nil {
		return err
	}
	typeOf := reflect.TypeOf(destination)
	if typeOf == nil || typeOf.Kind() != reflect.Pointer || reflect.ValueOf(destination).IsNil() {
		return fmt.Errorf("evidence: JSON destination must be a nonnil pointer")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	value, err := readJSONValue(decoder, 0)
	if err != nil {
		return fmt.Errorf("evidence: invalid JSON: %w", err)
	}
	if _, err := decoder.Token(); err != io.EOF {
		return fmt.Errorf("evidence: trailing JSON content")
	}
	if err := validateJSONShape(value, typeOf.Elem(), "$"); err != nil {
		return err
	}
	decoder = json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("evidence: invalid JSON field value: %w", err)
	}
	return nil
}

func readJSONValue(decoder *json.Decoder, depth int) (any, error) {
	if depth > 32 {
		return nil, fmt.Errorf("JSON nesting exceeds v1 bound")
	}
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delimiter, compound := token.(json.Delim)
	if !compound {
		return token, nil
	}
	switch delimiter {
	case '{':
		object := make(map[string]any)
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			key, ok := keyToken.(string)
			if !ok {
				return nil, fmt.Errorf("object key is not a string")
			}
			if _, exists := object[key]; exists {
				return nil, fmt.Errorf("duplicate JSON field %q", key)
			}
			value, err := readJSONValue(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			object[key] = value
		}
		if end, err := decoder.Token(); err != nil || end != json.Delim('}') {
			return nil, fmt.Errorf("unterminated JSON object")
		}
		return object, nil
	case '[':
		array := make([]any, 0)
		for decoder.More() {
			value, err := readJSONValue(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			array = append(array, value)
		}
		if end, err := decoder.Token(); err != nil || end != json.Delim(']') {
			return nil, fmt.Errorf("unterminated JSON array")
		}
		return array, nil
	default:
		return nil, fmt.Errorf("unexpected JSON delimiter")
	}
}

func validateJSONShape(value any, typ reflect.Type, path string) error {
	for typ.Kind() == reflect.Pointer {
		typ = typ.Elem()
	}
	switch typ.Kind() {
	case reflect.String:
		if _, ok := value.(string); !ok {
			return fmt.Errorf("evidence: %s must be a JSON string", path)
		}
	case reflect.Bool:
		if _, ok := value.(bool); !ok {
			return fmt.Errorf("evidence: %s must be a JSON boolean", path)
		}
	case reflect.Int, reflect.Int64, reflect.Uint64:
		if _, ok := value.(json.Number); !ok {
			return fmt.Errorf("evidence: %s must be a JSON integer", path)
		}
	case reflect.Struct:
		object, ok := value.(map[string]any)
		if !ok {
			return fmt.Errorf("evidence: %s must be a JSON object", path)
		}
		fields := make(map[string]reflect.StructField)
		for i := 0; i < typ.NumField(); i++ {
			field := typ.Field(i)
			if field.PkgPath != "" {
				continue
			}
			tag := strings.Split(field.Tag.Get("json"), ",")
			name := tag[0]
			if name == "-" {
				continue
			}
			if name == "" {
				name = field.Name
			}
			fields[name] = field
			if _, found := object[name]; !found && !strings.Contains(field.Tag.Get("json"), ",omitempty") {
				return fmt.Errorf("evidence: %s missing required JSON field %q", path, name)
			}
		}
		for name, item := range object {
			field, found := fields[name]
			if !found {
				return fmt.Errorf("evidence: %s unknown or aliased JSON field %q", path, name)
			}
			if err := validateJSONShape(item, field.Type, path+"."+name); err != nil {
				return err
			}
		}
	case reflect.Map:
		object, ok := value.(map[string]any)
		if !ok {
			return fmt.Errorf("evidence: %s must be a JSON object", path)
		}
		for name, item := range object {
			if err := validateJSONShape(item, typ.Elem(), path+"."+name); err != nil {
				return err
			}
		}
	case reflect.Slice:
		if typ.Elem().Kind() == reflect.Uint8 {
			if value == nil {
				return nil // Go JSON's representation of an explicitly nil []byte.
			}
			encoded, ok := value.(string)
			if !ok {
				return fmt.Errorf("evidence: %s must be canonical base64", path)
			}
			decoded, err := base64.StdEncoding.Strict().DecodeString(encoded)
			if err != nil || base64.StdEncoding.EncodeToString(decoded) != encoded {
				return fmt.Errorf("evidence: %s must be canonical base64", path)
			}
		}
	}
	return nil
}

// encoding/json replaces unpaired escaped UTF-16 surrogates with U+FFFD.
// Refuse that lossy conversion while accepting actual valid U+FFFD characters.
func validateSurrogates(raw []byte) error {
	inString := false
	for i := 0; i < len(raw); i++ {
		if raw[i] == '"' {
			inString = !inString
			continue
		}
		if !inString || raw[i] != '\\' {
			continue
		}
		if i+1 >= len(raw) {
			return fmt.Errorf("evidence: incomplete JSON string escape")
		}
		if raw[i+1] != 'u' {
			i++
			continue
		}
		if i+6 > len(raw) {
			return fmt.Errorf("evidence: incomplete JSON Unicode escape")
		}
		code, err := strconv.ParseUint(string(raw[i+2:i+6]), 16, 16)
		if err != nil {
			return fmt.Errorf("evidence: invalid JSON Unicode escape")
		}
		if code >= 0xD800 && code <= 0xDBFF {
			if i+12 > len(raw) || raw[i+6] != '\\' || raw[i+7] != 'u' {
				return fmt.Errorf("evidence: unpaired JSON surrogate")
			}
			low, err := strconv.ParseUint(string(raw[i+8:i+12]), 16, 16)
			if err != nil || low < 0xDC00 || low > 0xDFFF {
				return fmt.Errorf("evidence: unpaired JSON surrogate")
			}
			i += 11
		} else if code >= 0xDC00 && code <= 0xDFFF {
			return fmt.Errorf("evidence: unpaired JSON surrogate")
		} else {
			i += 5
		}
	}
	return nil
}
