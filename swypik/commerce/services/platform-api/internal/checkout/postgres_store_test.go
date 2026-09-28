package checkout

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestPostgresStoreAddCartItemPersistsPendingCommerceOrderItem(t *testing.T) {
	now := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	db := &recordingPostgresDB{
		rowResults: [][]any{{
			"22222222-2222-4222-8222-222222222222",
			now,
		}},
	}
	store := newPostgresStore(db)

	item, err := store.AddCartItem(context.Background(), CartItem{
		ID:            "cart_item_local",
		CartID:        "cart_123",
		UserID:        "11111111-1111-4111-8111-111111111111",
		ProductID:     "external_prod_1",
		SKUID:         "sku_1",
		Quantity:      2,
		UnitAmountRON: 1200,
		CreatedAt:     now,
	})
	if err != nil {
		t.Fatalf("expected cart item persisted, got %v", err)
	}
	if item.ID != "22222222-2222-4222-8222-222222222222" {
		t.Fatalf("expected database item id, got %q", item.ID)
	}

	query := db.onlyQuery(t)
	for _, want := range []string{
		"INSERT INTO commerce_orders",
		"commerce_order_items",
		"metadata",
		"cart_id",
		"merchant_of_record",
		"connect_charge_type",
	} {
		if !strings.Contains(query.sql, want) {
			t.Fatalf("expected SQL to contain %q:\n%s", want, query.sql)
		}
	}
	if query.args[0] != "cart_123" {
		t.Fatalf("expected cart id arg, got %#v", query.args[0])
	}
	itemMetadata := decodeJSONArg(t, query.args[7])
	if itemMetadata["external_product_id"] != "external_prod_1" {
		t.Fatalf("expected external product metadata, got %#v", itemMetadata["external_product_id"])
	}
	if itemMetadata["sku_id"] != "sku_1" {
		t.Fatalf("expected sku metadata, got %#v", itemMetadata["sku_id"])
	}
}

func TestPostgresStoreCreateCheckoutPersistsSessionOrderAndPayment(t *testing.T) {
	now := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	db := &recordingPostgresDB{
		rowResults: [][]any{{
			"33333333-3333-4333-8333-333333333333",
			"44444444-4444-4444-8444-444444444444",
			"55555555-5555-4555-8555-555555555555",
		}},
	}
	store := newPostgresStore(db)

	record, err := store.CreateCheckout(context.Background(), CheckoutRecord{
		CartID:            "cart_123",
		UserID:            "11111111-1111-4111-8111-111111111111",
		Provider:          "stripe",
		ProviderSessionID: "chk_local",
		Status:            "open",
		Currency:          "RON",
		AmountTotalRON:    2400,
		SuccessURL:        "https://swypik.local/checkout/success",
		CancelURL:         "https://swypik.local/checkout/cancel",
		CreatedAt:         now,
		Metadata: map[string]any{
			"merchant_of_record": "platform",
			"connect_charge_type": "destination_charge_ready",
		},
		Payment: PaymentRecord{
			Provider:          "stripe",
			ProviderPaymentID: "pi_pending_chk_local",
			Type:              "payment",
			Status:            "pending",
			Currency:          "RON",
			AmountRON:         2400,
			CreatedAt:         now,
		},
	})
	if err != nil {
		t.Fatalf("expected checkout persisted, got %v", err)
	}
	if record.OrderID != "33333333-3333-4333-8333-333333333333" {
		t.Fatalf("expected order id, got %q", record.OrderID)
	}
	if record.SessionID != "44444444-4444-4444-8444-444444444444" {
		t.Fatalf("expected checkout session id, got %q", record.SessionID)
	}
	if record.Payment.ID != "55555555-5555-4555-8555-555555555555" {
		t.Fatalf("expected payment transaction id, got %q", record.Payment.ID)
	}

	query := db.onlyQuery(t)
	for _, want := range []string{
		"UPDATE commerce_orders",
		"INSERT INTO checkout_sessions",
		"INSERT INTO payment_transactions",
		"provider_session_id",
		"provider_payment_id",
		"merchant_of_record",
		"connect_charge_type",
	} {
		if !strings.Contains(query.sql, want) {
			t.Fatalf("expected SQL to contain %q:\n%s", want, query.sql)
		}
	}
	if query.args[2] != "stripe" {
		t.Fatalf("expected stripe provider arg, got %#v", query.args[2])
	}
	if query.args[10] != "pending" {
		t.Fatalf("expected pending payment status arg, got %#v", query.args[10])
	}
}

type recordedQuery struct {
	sql  string
	args []any
}

type recordingPostgresDB struct {
	queries    []recordedQuery
	rowResults [][]any
}

func (db *recordingPostgresDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	panic("Exec is not used in these tests")
}

func (db *recordingPostgresDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	db.queries = append(db.queries, recordedQuery{sql: sql, args: append([]any(nil), args...)})
	result := []any(nil)
	if len(db.rowResults) > 0 {
		result = db.rowResults[0]
		db.rowResults = db.rowResults[1:]
	}
	return rowResult(result)
}

func (db *recordingPostgresDB) Query(context.Context, string, ...any) (pgx.Rows, error) {
	panic("Query is not used in these tests")
}

func (db *recordingPostgresDB) onlyQuery(t *testing.T) recordedQuery {
	t.Helper()
	if len(db.queries) != 1 {
		t.Fatalf("expected one query, got %d", len(db.queries))
	}
	return db.queries[0]
}

type rowResult []any

func (r rowResult) Scan(dest ...any) error {
	if len(dest) != len(r) {
		return pgx.ErrNoRows
	}
	for i := range dest {
		switch target := dest[i].(type) {
		case *string:
			*target = r[i].(string)
		case *time.Time:
			*target = r[i].(time.Time)
		default:
			panic("unsupported scan target")
		}
	}
	return nil
}

func decodeJSONArg(t *testing.T, arg any) map[string]any {
	t.Helper()
	raw, ok := arg.([]byte)
	if !ok {
		t.Fatalf("expected []byte JSON arg, got %T", arg)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("expected JSON payload, got %v", err)
	}
	return out
}
