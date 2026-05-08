# E-Commerce Industry Template

A production-ready collection of Blok workflows for building e-commerce backends. These templates cover the core transaction lifecycle from browsing to post-purchase, and are designed to integrate with common payment providers, inventory systems, and notification services.

## Included Workflows

### 1. Checkout Flow (`checkout.json`)

Orchestrates the full purchase process from cart validation through payment and confirmation.

**Trigger:** `POST /api/checkout`

**Steps:**
1. **validate-cart** -- Validates the incoming cart payload against a JSON schema (items, customer, shipping address, payment method).
2. **calculate-totals** -- Computes subtotal, tax, shipping cost, and discounts. Calls an external tax rate service for jurisdiction-accurate tax calculation.
3. **check-inventory** -- Sends a batch inventory check to the inventory service to confirm all items are available in the requested quantities.
4. **process-payment** -- Creates a Stripe PaymentIntent with the calculated total, confirms the charge, and captures payment metadata.
5. **reserve-inventory** -- Decrements available stock for each purchased item with a TTL-based reservation.
6. **create-order** -- Persists the order record with line items, totals, shipping details, and payment reference.
7. **send-confirmation-email** -- Sends a transactional order confirmation email via SendGrid with dynamic template data.

**Environment Variables:**
```
STRIPE_SECRET_KEY, INVENTORY_SERVICE_URL, ORDER_SERVICE_URL,
TAX_SERVICE_URL, SENDGRID_API_KEY, FROM_EMAIL, STORE_NAME,
ORDER_CONFIRMATION_TEMPLATE_ID, APP_URL, INTERNAL_API_KEY
```

---

### 2. Inventory Management (`inventory-management.json`)

Handles real-time inventory tracking, low-stock alerts, and automated reorder triggers.

**Trigger:** `POST /api/inventory/update`

**Steps:**
1. **validate-update** -- Validates the inventory update payload (product ID, warehouse, quantity delta, reason).
2. **fetch-current-stock** -- Retrieves the current stock level from the inventory database.
3. **apply-adjustment** -- Applies the quantity adjustment (increment or decrement) and records the audit trail.
4. **check-thresholds** -- Evaluates whether the new stock level crosses any configured alert thresholds.
5. **route-threshold** -- If the stock is below the reorder point, triggers the automated reorder process. Otherwise, completes normally.
6. **create-purchase-order** -- Generates a purchase order to the configured supplier when stock is below the reorder threshold.
7. **notify-warehouse** -- Sends a Slack notification to the warehouse operations channel with stock level details.

**Environment Variables:**
```
INVENTORY_DB_URL, SUPPLIER_API_URL, SLACK_WEBHOOK_URL,
REORDER_THRESHOLD, INTERNAL_API_KEY
```

---

### 3. Order Fulfillment (`order-fulfillment.json`)

Manages the order lifecycle from confirmed status through picking, packing, shipping, and delivery tracking.

**Trigger:** `POST /api/orders/fulfill`

**Steps:**
1. **fetch-order** -- Retrieves the complete order record including line items and shipping details.
2. **assign-warehouse** -- Determines the optimal fulfillment warehouse based on item availability and proximity to the shipping destination.
3. **generate-pick-list** -- Creates a pick list for warehouse staff with bin locations and quantities.
4. **request-shipping-label** -- Calls the shipping carrier API (UPS, FedEx, or USPS) to generate a shipping label and tracking number.
5. **update-order-status** -- Updates the order record with the tracking number, carrier, and "shipped" status.
6. **notify-customer** -- Sends a shipment notification email with the tracking link and estimated delivery date.

**Environment Variables:**
```
ORDER_SERVICE_URL, WAREHOUSE_SERVICE_URL, SHIPPING_CARRIER_API_URL,
SHIPPING_CARRIER_API_KEY, SENDGRID_API_KEY, FROM_EMAIL,
SHIPMENT_TEMPLATE_ID, APP_URL, INTERNAL_API_KEY
```

---

### 4. Payment Processing (`payment-processing.json`)

Handles payment lifecycle events including charges, refunds, disputes, and reconciliation.

**Trigger:** `POST /api/payments/webhook`

**Steps:**
1. **verify-webhook** -- Validates the Stripe webhook signature using the endpoint secret.
2. **parse-event** -- Extracts the event type, object data, and metadata from the webhook payload.
3. **route-event-type** -- Routes to the appropriate handler based on the Stripe event type:
   - `payment_intent.succeeded` -- Updates order payment status and triggers fulfillment.
   - `charge.refunded` -- Processes the refund, updates the order, and restores inventory.
   - `charge.dispute.created` -- Flags the order, notifies the finance team, and gathers dispute evidence.
4. **update-ledger** -- Records the financial transaction in the accounting ledger for reconciliation.
5. **notify-finance** -- Sends a notification to the finance team for high-value transactions or disputes.

**Environment Variables:**
```
STRIPE_WEBHOOK_SECRET, STRIPE_SECRET_KEY, ORDER_SERVICE_URL,
INVENTORY_SERVICE_URL, LEDGER_SERVICE_URL, SLACK_WEBHOOK_URL,
FINANCE_EMAIL, INTERNAL_API_KEY
```

---

### 5. Notification System (`notification-system.json`)

Centralized notification hub that routes messages across email, SMS, push, and in-app channels.

**Trigger:** `POST /api/notifications/send`

**Steps:**
1. **validate-notification** -- Validates the notification payload (recipient, channel, template, data).
2. **fetch-user-preferences** -- Retrieves the recipient's notification preferences and opted-in channels.
3. **route-channel** -- Routes to the appropriate delivery channel based on the notification type and user preferences:
   - `email` -- Sends via SendGrid with dynamic templates.
   - `sms` -- Sends via Twilio with message templates.
   - `push` -- Sends via Firebase Cloud Messaging.
   - `in_app` -- Stores the notification in the database for in-app display.
4. **record-delivery** -- Logs the delivery attempt with status, channel, and timestamp for analytics.
5. **handle-failure** -- If delivery fails, queues a retry with exponential backoff or falls back to an alternative channel.

**Environment Variables:**
```
SENDGRID_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
TWILIO_PHONE_NUMBER, FCM_SERVER_KEY, NOTIFICATION_DB_URL,
FROM_EMAIL, INTERNAL_API_KEY
```

---

## Getting Started

1. Copy the desired workflow JSON files into your project's `workflows/json/` directory.
2. Set the required environment variables for each workflow in your `.env` file.
3. Install the required blok modules:
   ```bash
   npx blok install @blokjs/api-call @blokjs/if-else @blokjs/json-validator
   ```
4. Start the Blok runtime:
   ```bash
   npx blok dev
   ```
5. Test the workflows using curl or your preferred API client.

## Architecture Notes

- **Idempotency:** The checkout and payment workflows use Stripe's idempotency keys and order deduplication to prevent double charges.
- **Saga Pattern:** The checkout flow uses compensating transactions: if order creation fails after payment, a refund is automatically initiated.
- **Event-Driven:** The payment processing workflow listens for Stripe webhook events, decoupling payment confirmation from the checkout request.
- **Multi-Channel:** The notification system supports graceful degradation across channels, falling back from push to email to SMS as needed.
