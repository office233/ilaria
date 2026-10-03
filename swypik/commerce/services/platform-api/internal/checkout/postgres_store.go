package checkout

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
)

type postgresDB interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

type postgresStore struct {
	db postgresDB
}

func newPostgresStore(db postgresDB) *postgresStore {
	return &postgresStore{db: db}
}

func NewPostgresStore(db postgresDB) Store {
	return newPostgresStore(db)
}

func (s *postgresStore) AddCartItem(ctx context.Context, item CartItem) (CartItem, error) {
	metadata, err := json.Marshal(map[string]any{
		"cart_id":             item.CartID,
		"external_product_id": item.ProductID,
		"sku_id":              item.SKUID,
		"merchant_of_record":  "platform",
		"connect_charge_type": "destination_charge_ready",
	})
	if err != nil {
		return CartItem{}, err
	}
	row := s.db.QueryRow(ctx, `
/* metadata keys: cart_id merchant_of_record connect_charge_type */
WITH order_row AS (
	INSERT INTO commerce_orders (buyer_user_id, status, currency, subtotal_cents, total_cents, metadata, created_at)
	VALUES (NULLIF($2, '')::uuid, 'pending', 'RON', $3, $3, $4, $5)
	ON CONFLICT ((metadata->>'cart_id'))
	WHERE status = 'pending' AND metadata ? 'cart_id'
	DO UPDATE SET
		subtotal_cents = commerce_orders.subtotal_cents + EXCLUDED.subtotal_cents,
		total_cents = commerce_orders.total_cents + EXCLUDED.total_cents,
		metadata = commerce_orders.metadata || EXCLUDED.metadata,
		updated_at = now()
	RETURNING id
), item_row AS (
	INSERT INTO commerce_order_items (order_id, title, quantity, currency, unit_amount_cents, gross_amount_cents, commissionable_amount_cents, metadata, created_at)
	SELECT id, $6, $9, 'RON', $10, $3, $3, $8, $5 FROM order_row
	RETURNING id, created_at
)
SELECT id::text, created_at FROM item_row`,
		item.CartID,
		item.UserID,
		item.UnitAmountRON*item.Quantity,
		metadata,
		item.CreatedAt,
		item.ProductID,
		item.SKUID,
		metadata,
		item.Quantity,
		item.UnitAmountRON,
	)
	if err := row.Scan(&item.ID, &item.CreatedAt); err != nil {
		return CartItem{}, err
	}
	return item, nil
}

func (s *postgresStore) ListCartItems(ctx context.Context, cartID string) ([]CartItem, error) {
	rows, err := s.db.Query(ctx, `
SELECT
	item.id::text,
	ord.metadata->>'cart_id',
	COALESCE(ord.buyer_user_id::text, ''),
	COALESCE(item.metadata->>'external_product_id', ''),
	COALESCE(item.metadata->>'sku_id', ''),
	item.quantity,
	item.unit_amount_cents,
	item.created_at
FROM commerce_order_items item
JOIN commerce_orders ord ON ord.id = item.order_id
WHERE ord.metadata->>'cart_id' = $1
  AND ord.status = 'pending'
ORDER BY item.created_at`, cartID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []CartItem{}
	for rows.Next() {
		var item CartItem
		if err := rows.Scan(
			&item.ID,
			&item.CartID,
			&item.UserID,
			&item.ProductID,
			&item.SKUID,
			&item.Quantity,
			&item.UnitAmountRON,
			&item.CreatedAt,
		); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *postgresStore) CreateCheckout(ctx context.Context, record CheckoutRecord) (CheckoutRecord, error) {
	metadata, err := json.Marshal(record.Metadata)
	if err != nil {
		return CheckoutRecord{}, err
	}
	row := s.db.QueryRow(ctx, `
/* metadata keys: merchant_of_record connect_charge_type */
WITH order_row AS (
	UPDATE commerce_orders
	SET status = 'authorized', currency = $1, subtotal_cents = $2, total_cents = $2, metadata = metadata || $4::jsonb
	WHERE metadata->>'cart_id' = $5
	  AND status = 'pending'
	RETURNING id
), session_row AS (
	INSERT INTO checkout_sessions (order_id, provider, provider_session_id, status, currency, amount_total_cents, success_url, cancel_url, metadata, created_at)
	SELECT id, $3, $6, $7, $1, $2, $8, $9, $4, $10 FROM order_row
	RETURNING id
), payment_row AS (
	INSERT INTO payment_transactions (order_id, checkout_session_id, provider, provider_payment_id, transaction_type, status, currency, amount_cents, metadata, created_at)
	SELECT order_row.id, session_row.id, $12, $13, $14, $11, $1, $15, $4, $16 FROM order_row, session_row
	ON CONFLICT (provider, provider_payment_id, transaction_type) DO UPDATE SET status = EXCLUDED.status
	RETURNING id
)
SELECT order_row.id::text, session_row.id::text, payment_row.id::text FROM order_row, session_row, payment_row`,
		record.Currency,
		record.AmountTotalRON,
		record.Provider,
		metadata,
		record.CartID,
		record.ProviderSessionID,
		record.Status,
		record.SuccessURL,
		record.CancelURL,
		record.CreatedAt,
		record.Payment.Status,
		record.Payment.Provider,
		record.Payment.ProviderPaymentID,
		record.Payment.Type,
		record.Payment.AmountRON,
		record.Payment.CreatedAt,
	)
	if err := row.Scan(&record.OrderID, &record.SessionID, &record.Payment.ID); err != nil {
		return CheckoutRecord{}, err
	}
	return record, nil
}
