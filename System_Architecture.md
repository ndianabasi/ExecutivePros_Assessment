# System Architecture / Design Document

## Author: Ndianabasi Udonkang (Senior Software Engineer)

## Email: ndianabasi.udonkang@gmail.com

In partial fulfillment of the ExecutivePro Assessment for Node.js + React Developer Role

## Summary

This system architecture document is focused on the design of a Node.js microservice which safely and reliably handles payment processing requests and provides interfaces for authorised users to review payments.

Four microservices are proposed within this architecture:

1. API Service,
2. Frontend Service,
3. Message Queue Service,
4. API Documentation Service,
5. Mock Email Service, and
6. Mock Payment Provider Service

### 1. API Service

The API service is the main application backend. It will be developed with TypeScript for the Nodejs runtime using the Express framework. The API Service will domicile all proposed endpoints to be called from the Frontend Service and will provide authentication, authorisation, and security for all API requests.

### 2. Frontend Service

The Frontend Service will provide the user interface for interacting with the API service and receiving real-time events from the API service.

### 3. Message Queue Service

The Message Queue Service will provide an asynchronous messaging queue which the API Service can publish jobs to for asynchronous processing.

### 4. API Documentation Service

The API Documentation Service will provide an user interface to exploring the functionalities of the endpoints exposed by the API service.

### 5. Mock Payment Provider Service

The Mock Payment Provider Service will be used to simulate a real payment provider. The Mock Payment Provider will emit webhook events to the API Service. The API Service is expected to handle the different events robustly. The webhook event data will be simplified.

### 6. Mock Email Service

The Mock Email Service will be used to delivery email to interested parties within the system. It will have its own port. The Frontend Service is expected to provide a simple, global interface element for accessing the Mock Email Service within its own interface.

## Reference-Level Explanations

### Architecture / Workflow Overview

The flowchart below presents the relationship between the four (4) proposed microservices. Details of each microservice will be discussed in sections below.

![Microservices Flowchart](microservice_architecture.png)

### Database and Data Models

#### Database Engine

The SQLite database engine will be used for file-based data persistence. In-memory or JSON file persistence recommended in the brief will not be used due the data persistence requirements of the API and Message Queue Services. SQLite meets the simplicity requirements as we are not spawning a full-blown database server like PostgreSQL.

All SQLite database files should be stored in a volume accessible by the API service, Message Queue Service and Mock Payment Provider Service.

#### Data Models

The following databases and tables will be needed for the operations to be performed by the 4 microservices.

##### Database and Tables Managed by the API Service

Below is a proposed relational database schema for `api.db`, using **SQLite-compatible data types** and constraints.

The schema includes the four requested tables, plus a `cart_items` table to support carts containing multiple products.

###### 1.`api.db / users`

The `users` table stores basic information about users who are authenticated or authorised to perform API operations.

| Name         | Data Type | Constraints                                                   | Description                                                      |
| ------------ | --------- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| `id`         | INTEGER   | PRIMARY KEY, AUTOINCREMENT                                    | Unique identifier for each user.                                 |
| `first_name` | TEXT      | NOT NULL                                                      | User's first name.                                               |
| `last_name`  | TEXT      | NOT NULL                                                      | User's last name.                                                |
| `email`      | TEXT      | NOT NULL, UNIQUE                                              | User's email address, used for authentication and communication. |
| `role`       | TEXT      | NOT NULL, DEFAULT 'user', CHECK (`role IN ('user', 'admin')`) | Determines the user's authorisation level.                       |
| `is_active`  | INTEGER   | NOT NULL, DEFAULT 1, CHECK (`is_active IN (0, 1)`)            | Indicates whether the user's account is active.                  |
| `created_at` | TEXT      | NOT NULL, DEFAULT CURRENT_TIMESTAMP                           | Timestamp when the user account was created.                     |
| `updated_at` | TEXT      | NOT NULL, DEFAULT CURRENT_TIMESTAMP                           | Timestamp when the user account was last updated.                |

###### 2.`api.db / payments`

The `payments` table stores simplified information about payments initiated by users. Each payment references the cart being checked out.

| Name                 | Data Type | Constraints                                                                                    | Description                                                          |
| -------------------- | --------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `id`                 | INTEGER   | PRIMARY KEY, AUTOINCREMENT                                                                     | Unique identifier for each payment.                                  |
| `user_id`            | INTEGER   | NOT NULL, FOREIGN KEY -> `users(id)`                                                           | Identifies the user who initiated the payment.                       |
| `cart_id`            | INTEGER   | NOT NULL, FOREIGN KEY -> `carts(id)`                                                           | Identifies the cart associated with the payment.                     |
| `reference`          | TEXT      | NOT NULL, UNIQUE                                                                               | Unique payment reference used for tracking transactions.             |
| `amount`             | INTEGER   | NOT NULL, CHECK (`amount >= 0`)                                                                | Total payment amount in the currency's smallest unit (e.g., kobo).   |
| `currency`           | TEXT      | NOT NULL, DEFAULT 'NGN'                                                                        | ISO 4217 currency code associated with the payment.                  |
| `status`             | TEXT      | NOT NULL, DEFAULT 'pending', CHECK (`status IN ('pending', 'success', 'failed', 'cancelled')`) | Current status of the payment.                                       |
| `provider`           | TEXT      | NULL                                                                                           | Payment service provider responsible for processing the transaction. |
| `provider_reference` | TEXT      | NULL, UNIQUE                                                                                   | Transaction reference returned by the payment provider.              |
| `paid_at`            | TEXT      | NULL                                                                                           | Timestamp when the payment was successfully completed.               |
| `created_at`         | TEXT      | NOT NULL, DEFAULT CURRENT_TIMESTAMP                                                            | Timestamp when the payment record was created.                       |
| `updated_at`         | TEXT      | NOT NULL, DEFAULT CURRENT_TIMESTAMP                                                            | Timestamp when the payment record was last updated.                  |

###### 3.`api.db / products`

The `products` table stores simplified information about products available for users to purchase.

| Name             | Data Type | Constraints                                        | Description                                                 |
| ---------------- | --------- | -------------------------------------------------- | ----------------------------------------------------------- |
| `id`             | INTEGER   | PRIMARY KEY, AUTOINCREMENT                         | Unique identifier for each product.                         |
| `name`           | TEXT      | NOT NULL                                           | Name of the product.                                        |
| `description`    | TEXT      | NULL                                               | Detailed description of the product.                        |
| `sku`            | TEXT      | NOT NULL, UNIQUE                                   | Stock Keeping Unit used to uniquely identify a product.     |
| `price`          | INTEGER   | NOT NULL, CHECK (`price >= 0`)                     | Unit price of the product in the currency's smallest unit.  |
| `currency`       | TEXT      | NOT NULL, DEFAULT 'NGN'                            | ISO 4217 currency code associated with the product's price. |
| `stock_quantity` | INTEGER   | NOT NULL, DEFAULT 0, CHECK (`stock_quantity >= 0`) | Number of units currently available for purchase.           |
| `is_active`      | INTEGER   | NOT NULL, DEFAULT 1, CHECK (`is_active IN (0, 1)`) | Indicates whether the product is available for purchase.    |
| `created_at`     | TEXT      | NOT NULL, DEFAULT CURRENT_TIMESTAMP                | Timestamp when the product was created.                     |
| `updated_at`     | TEXT      | NOT NULL, DEFAULT CURRENT_TIMESTAMP                | Timestamp when the product was last updated.                |

###### 4.`api.db / carts`

The `carts` table stores information about shopping carts created by users. Each cart contains one or more products when checked out and can be associated with a payment.

| Name             | Data Type | Constraints                                                                            | Description                                                       |
| ---------------- | --------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `id`             | INTEGER   | PRIMARY KEY, AUTOINCREMENT                                                             | Unique identifier for each cart.                                  |
| `user_id`        | INTEGER   | NOT NULL, FOREIGN KEY -> `users(id)`                                                   | Identifies the user who owns the cart.                            |
| `status`         | TEXT      | NOT NULL, DEFAULT 'active', CHECK (`status IN ('active', 'checked_out', 'abandoned')`) | Current lifecycle status of the cart.                             |
| `currency`       | TEXT      | NOT NULL, DEFAULT 'NGN'                                                                | ISO 4217 currency code used for the cart.                         |
| `total_amount`   | INTEGER   | NOT NULL, DEFAULT 0, CHECK (`total_amount >= 0`)                                       | Total monetary value of the cart in the currency's smallest unit. |
| `checked_out_at` | TEXT      | NULL                                                                                   | Timestamp when the user checked out the cart.                     |
| `created_at`     | TEXT      | NOT NULL, DEFAULT CURRENT_TIMESTAMP                                                    | Timestamp when the cart was created.                              |
| `updated_at`     | TEXT      | NOT NULL, DEFAULT CURRENT_TIMESTAMP                                                    | Timestamp when the cart was last updated.                         |

###### 5.`api.db / cart_items`

The `cart_items` table establishes the many-to-many relationship between carts and products. It allows a single cart to contain multiple products, and the same product to appear in multiple carts.

| Name         | Data Type | Constraints                                            | Description                                                                           |
| ------------ | --------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `id`         | INTEGER   | PRIMARY KEY, AUTOINCREMENT                             | Unique identifier for each cart item.                                                 |
| `cart_id`    | INTEGER   | NOT NULL, FOREIGN KEY -> `carts(id)` ON DELETE CASCADE | Identifies the cart containing the product.                                           |
| `product_id` | INTEGER   | NOT NULL, FOREIGN KEY -> `products(id)`                | Identifies the product added to the cart.                                             |
| `quantity`   | INTEGER   | NOT NULL, DEFAULT 1, CHECK (`quantity > 0`)            | Number of units of the product in the cart.                                           |
| `unit_price` | INTEGER   | NOT NULL, CHECK (`unit_price >= 0`)                    | Snapshot of the product's unit price when added to the cart or finalised at checkout. |
| `created_at` | TEXT      | NOT NULL, DEFAULT CURRENT_TIMESTAMP                    | Timestamp when the product was added to the cart.                                     |
| `updated_at` | TEXT      | NOT NULL, DEFAULT CURRENT_TIMESTAMP                    | Timestamp when the cart item was last updated.                                        |

**Additional table-level constraint:** `UNIQUE (cart_id, product_id)` prevents the same product from appearing in multiple rows within a single cart.

## 6.`api.db / user_tokens`

The `user_tokens` table stores opaque authentication tokens associated with users. Each user can have multiple tokens, allowing authentication across different sessions or devices.

| Name           | Data Type | Constraints                                           | Description                                                                          |
| -------------- | --------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `id`           | INTEGER   | PRIMARY KEY, AUTOINCREMENT                            | Unique identifier for each token record.                                             |
| `user_id`      | INTEGER   | NOT NULL, FOREIGN KEY → `users(id)` ON DELETE CASCADE | Identifies the user who owns the token.                                              |
| `token_hash`   | TEXT      | NOT NULL, UNIQUE                                      | Cryptographic hash of the opaque authentication token.                               |
| `expires_at`   | TEXT      | NOT NULL                                              | Timestamp after which the token is no longer valid.                                  |
| `revoked_at`   | TEXT      | NULL                                                  | Timestamp when the token was revoked. NULL indicates the token has not been revoked. |
| `created_at`   | TEXT      | NOT NULL, DEFAULT CURRENT_TIMESTAMP                   | Timestamp when the token was generated.                                              |
| `last_used_at` | TEXT      | NULL                                                  | Timestamp when the token was last used for authentication.                           |

###### 7. Database relationships

Simplified entity relationship diagram. N = many.

The schema supports these relationships:

- **Users -> Carts:** One user can own multiple carts.
- **Users -> Payments:** One user can initiate multiple payments.
- **Carts -> Payments:** One cart can have multiple payment attempts.
- **Carts -> Cart Items:** One cart can contain multiple cart items.
- **Products -> Cart Items:** One product can appear in multiple carts.
- **Users -> User Tokens:** One user can log in multiple times.

##### `jobs.db` Database

The tables within the `jobs.db` database will be managed internally by the Message Queue Service, and as such, will not be discussed here.

##### `payment_provider.db` Database

The `payment_provider.db` database stores information required by the Mock Payment Provider Service to initialise payments, simulate payment completion, manage webhook deliveries, and reproduce configurable failure scenarios.

For the simplified implementation, the database should contain the following tables:

1. `payments` — Stores payment transactions initialised by the API Service.
2. `webhook_events` — Stores webhook events generated when payment statuses change.
3. `webhook_deliveries` — Tracks webhook delivery attempts, retries, and responses from the API Service.
4. `failure_scenarios` — Stores configurable failure scenarios associated with payments.

###### 1. `payment_provider.db / payments`

The `payments` table stores information about payment transactions initialised through the Mock Payment Provider. Each payment is associated with a unique payment reference supplied by the API Service.

| Name                  | Data Type | Constraints                                                                                    | Description                                                              |
| --------------------- | --------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `id`                  | INTEGER   | PRIMARY KEY, AUTOINCREMENT                                                                     | Unique identifier for each payment transaction.                          |
| `reference`           | TEXT      | NOT NULL, UNIQUE                                                                               | Unique payment reference supplied by the API Service.                    |
| `amount`              | INTEGER   | NOT NULL, CHECK (`amount > 0`)                                                                 | Payment amount in the currency's smallest denomination (e.g., kobo).     |
| `currency`            | TEXT      | NOT NULL, DEFAULT 'NGN'                                                                        | Currency associated with the payment transaction.                        |
| `status`              | TEXT      | NOT NULL, DEFAULT 'pending', CHECK (`status IN ('pending', 'success', 'failed', 'cancelled')`) | Current status of the payment transaction.                               |
| `payment_url`         | TEXT      | NOT NULL                                                                                       | URL where the user can simulate completing the payment.                  |
| `failure_scenario_id` | INTEGER   | NULL, FOREIGN KEY → `failure_scenarios(id)`                                                    | References the failure scenario to be simulated for this payment.        |
| `completed_at`        | TEXT      | NULL                                                                                           | Timestamp when the payment was completed successfully or unsuccessfully. |
| `created_at`          | TEXT      | NOT NULL, DEFAULT CURRENT_TIMESTAMP                                                            | Timestamp when the payment was initialised.                              |
| `updated_at`          | TEXT      | NOT NULL, DEFAULT CURRENT_TIMESTAMP                                                            | Timestamp when the payment record was last updated.                      |

###### 2. `payment_provider.db / webhook_events`

The `webhook_events` table stores webhook events generated by the Mock Payment Provider when a payment is completed or its status changes.

Each event represents a particular payment outcome and can be delivered to the API Service multiple times to simulate duplicate webhooks, delayed webhooks, and retry scenarios.

| Name           | Data Type | Constraints                                                                                                  | Description                                                                                  |
| -------------- | --------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `id`           | INTEGER   | PRIMARY KEY, AUTOINCREMENT                                                                                   | Unique identifier for each webhook event.                                                    |
| `payment_id`   | INTEGER   | NOT NULL, FOREIGN KEY → `payments(id)`                                                                       | Identifies the payment associated with the webhook event.                                    |
| `event_id`     | TEXT      | NOT NULL, UNIQUE                                                                                             | Unique identifier for the webhook event, used for event-level idempotency.                   |
| `event_type`   | TEXT      | NOT NULL, CHECK (`event_type IN ('payment.success', 'payment.failed', 'payment.cancelled')`)                 | Type of payment event being communicated.                                                    |
| `payload`      | TEXT      | NOT NULL                                                                                                     | JSON-encoded webhook payload containing the payment reference, amount, currency, and status. |
| `status`       | TEXT      | NOT NULL, DEFAULT 'pending', CHECK (`status IN ('pending', 'delivering', 'delivered', 'failed', 'skipped')`) | Current delivery lifecycle status of the webhook event.                                      |
| `scheduled_at` | TEXT      | NOT NULL, DEFAULT CURRENT_TIMESTAMP                                                                          | Timestamp when the webhook event is scheduled for delivery.                                  |
| `created_at`   | TEXT      | NOT NULL, DEFAULT CURRENT_TIMESTAMP                                                                          | Timestamp when the webhook event was generated.                                              |
| `updated_at`   | TEXT      | NOT NULL, DEFAULT CURRENT_TIMESTAMP                                                                          | Timestamp when the webhook event record was last updated.                                    |

###### 3. `payment_provider.db / webhook_deliveries`

The `webhook_deliveries` table tracks individual attempts to deliver a webhook event to the API Service.

A webhook event can have multiple delivery records, allowing the Mock Payment Provider to simulate retries, duplicate submissions, network timeouts, HTTP errors, and concurrent webhook deliveries.

| Name               | Data Type | Constraints                                                                                  | Description                                                          |
| ------------------ | --------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `id`               | INTEGER   | PRIMARY KEY, AUTOINCREMENT                                                                   | Unique identifier for each webhook delivery attempt.                 |
| `webhook_event_id` | INTEGER   | NOT NULL, FOREIGN KEY → `webhook_events(id)`                                                 | Identifies the webhook event being delivered.                        |
| `attempt_number`   | INTEGER   | NOT NULL, CHECK (`attempt_number > 0`)                                                       | Sequential attempt number for webhook delivery.                      |
| `status`           | TEXT      | NOT NULL, DEFAULT 'pending', CHECK (`status IN ('pending', 'success', 'failed', 'timeout')`) | Outcome of the webhook delivery attempt.                             |
| `http_status_code` | INTEGER   | NULL                                                                                         | HTTP status code returned by the API Service.                        |
| `response_body`    | TEXT      | NULL                                                                                         | Response body returned by the API Service during webhook submission. |
| `error_message`    | TEXT      | NULL                                                                                         | Description of a network error, timeout, or delivery failure.        |
| `attempted_at`     | TEXT      | NULL                                                                                         | Timestamp when the delivery attempt was initiated.                   |
| `completed_at`     | TEXT      | NULL                                                                                         | Timestamp when the delivery attempt finished.                        |
| `created_at`       | TEXT      | NOT NULL, DEFAULT CURRENT_TIMESTAMP                                                          | Timestamp when the delivery attempt record was created.              |

**Note:** `attempt_number` should be unique per webhook event for sequential retries. Intentional concurrent duplicates can be represented as separate attempts with distinct numbers.

###### 4. `payment_provider.db / failure_scenarios`

The `failure_scenarios` table stores predefined scenarios that the Mock Payment Provider can simulate during payment initialisation, payment completion, or webhook delivery.

Each scenario has a unique code that the Frontend Service can send to the API Service, which forwards it to the Mock Payment Provider.

| Name            | Data Type | Constraints                                                              | Description                                                                                               |
| --------------- | --------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `id`            | INTEGER   | PRIMARY KEY, AUTOINCREMENT                                               | Unique identifier for each failure scenario.                                                              |
| `code`          | TEXT      | NOT NULL, UNIQUE                                                         | Unique scenario identifier, such as `WEBHOOK_001` or `PROVIDER_001`.                                      |
| `name`          | TEXT      | NOT NULL                                                                 | Human-readable name of the failure scenario.                                                              |
| `description`   | TEXT      | NULL                                                                     | Description of the failure behaviour being simulated.                                                     |
| `category`      | TEXT      | NOT NULL, CHECK (`category IN ('initialisation', 'payment', 'webhook')`) | Stage of the payment lifecycle where the failure will be simulated.                                       |
| `configuration` | TEXT      | NULL                                                                     | JSON-encoded configuration for the scenario, such as delay duration, duplicate count, or HTTP error code. |
| `is_active`     | INTEGER   | NOT NULL, DEFAULT 1, CHECK (`is_active IN (0, 1)`)                       | Indicates whether the scenario is available for simulation.                                               |
| `created_at`    | TEXT      | NOT NULL, DEFAULT CURRENT_TIMESTAMP                                      | Timestamp when the failure scenario was created.                                                          |
| `updated_at`    | TEXT      | NOT NULL, DEFAULT CURRENT_TIMESTAMP                                      | Timestamp when the failure scenario was last updated.                                                     |

###### 5. Database relationships\*\*

Simplified entity relationship diagram for the Mock Payment Provider.

| Relationship                          | Type        | Description                                                              |
| ------------------------------------- | ----------- | ------------------------------------------------------------------------ |
| `failure_scenarios → payments`        | One-to-Many | A failure scenario can be associated with multiple payment transactions. |
| `payments → webhook_events`           | One-to-Many | A payment can generate multiple webhook events.                          |
| `webhook_events → webhook_deliveries` | One-to-Many | A webhook event can have multiple delivery attempts.                     |

###### 6. Example failure scenario records\*\*

The following scenarios can be seeded into the `failure_scenarios` table.

| Code           | Name                            | Category         | Configuration                                 |
| -------------- | ------------------------------- | ---------------- | --------------------------------------------- |
| `PROVIDER_001` | Provider timeout                | `initialisation` | `{"delay_ms": 30000}`                         |
| `PROVIDER_002` | Provider internal error         | `initialisation` | `{"http_status": 500}`                        |
| `WEBHOOK_001`  | Simultaneous duplicate webhooks | `webhook`        | `{"duplicate_count": 2, "concurrent": true}`  |
| `WEBHOOK_002`  | Sequential duplicate webhooks   | `webhook`        | `{"duplicate_count": 3, "interval_ms": 1000}` |
| `WEBHOOK_003`  | Delayed webhook                 | `webhook`        | `{"delay_ms": 15000}`                         |
| `WEBHOOK_004`  | Missing webhook                 | `webhook`        | `{"skip_delivery": true}`                     |
| `WEBHOOK_008`  | Conflicting webhook events      | `webhook`        | `{"statuses": ["success", "failed"]}`         |
| `WEBHOOK_011`  | Incorrect payment amount        | `webhook`        | `{"amount_difference": 1000}`                 |
| `WEBHOOK_013`  | Invalid webhook signature       | `webhook`        | `{"invalid_signature": true}`                 |
| `WEBHOOK_016`  | Malformed webhook payload       | `webhook`        | `{"malformed_payload": true}`                 |

###### 7. Implementation Considerations\*\*

1. The payment lifecycle should be separate from the webhook delivery lifecycle. A payment may be successfully completed at the provider while its webhook delivery fails, so the two statuses must be tracked independently.
2. The `payments` table should store the authoritative simulated payment outcome. The `webhook_events` table should capture immutable event payloads, while `webhook_deliveries` records individual delivery attempts and their results. For testing malformed or modified payloads, store the original event separately from the actual transmitted request, or extend delivery records to capture the transmitted payload.
3. For deterministic simulations, resolve and snapshot the selected failure configuration when a payment is initialised. This avoids later changes to a predefined scenario unexpectedly changing the behaviour of an existing payment. Provider-initialisation failures that happen before a payment is persisted may require a separate request log if you need to inspect those failures.

### API Service Design

#### Required Endpoints

The following endpoints are required:

1. `POST /v1/login`

Logs an existing user in without a password.

2. `GET /v1/products`

Fetches all seeded products (with optional pagination). There will be no endpoint for creating products and no endpoint for fetching a single product.

3. `POST /v1/cart`

Creates a cart (if no active cart exists) and adds the accompanied products to the cart. A user will have only one active cart at a time. An active cart is one which is not checked out yet.

3. `POST /v1/cart/checkout`

Checks out an active cart and initialises the payment flow for the cart.

4. `POST /v1/webhooks/payment`

A webhook event endpoint used by the Mock Payment Provider to notify the API Service of an incoming payment.

5. `GET /v1/payments/:payment_id`

Fetches the complete details of a payment including associated resources.

Access Level: Admin

** NOTE : ** There will be no endpoint for manually updating a payment status. Such an endpoint will be a security flaw. Payment statuses can only be updated during webhook handling or via a CRON job which marks payments which has been in pending state for more 30 days as failed payments.

#### Payment Flow

The payment flow begins with the checkout of an active cart from the Frontend Service or API Documentation Service (client). The checkout process initialises the payment. During payment intialisation:

1. The API service records the initialised payment,
2. The API service calls the Mock Payment Provider with the total amount and payment reference,
3. The Mock Payment Provider returns the payment URL to the API service,
4. The API service proxies the payment URL to the client.
5. The client visits the payment URL and requires the user to complete the payment.
6. The Mock Payment Provider receives the completed payment.
7. The Mock Payment Provider calls the API service with the details of the completed payment.
8. The API Service verifies the payment details in the webhook event.
9. If payment is verified, the API service grants value to the user and notifies the Frontend Service via server-sent event. Emails should also be sent to all interested parties.
10. If payment processing fails, the API service notifies the Frontend Service via server-sent event. Emails should also be sent to all interested parties.

In order to simulate failure cases, the Frontend Service is expected to integrate a integrate a list of failure scenarios to be generated. The selected scenario will be sent with the cart checkout request to the API service. Any scenario which involves the Mock Payment Provider will be forwarded to the Mock Payment Provider during the payment initialisation. The Mock Payment Provider is expected to simulate that failure mode during its webhook event submission to the API Service.

Such failure scenarios include (but not limited to):

1. Simultaneous double checkout of a cart.
2. Frontend Service client timeout and checkout retry.
3. Mock Payment Provider connection timeout.
4. Mock Payment Provider response lost.
5. Simultaneous duplicate webhooks from Mock API service.
6. Conflicting webhook events from Mock Payment Provider.
7. Incorrect payment amount from Mock Payment Provider.
8. Invalid webhook signature from Mock Payment Provider.
9. Crash within API service after granting value.
10. SSE client disconnected.

#### Authentication for Endpoints

- All endpoints shall require authentication.
- There will be no password-based login from the Frontend Service. Rather, a dropdown list of seeded users will be displayed on the Frontend Service for the user to choose and login with. The role of user should be displayed against the user on the Frontend Service.
- Token generation: a cryptographically secure random opaque token should be generated for the user during the login request.
- Token storage: Store a SHA-256 hash of the token in the `user_tokens` table, associated with the user's id. Return the raw token to the client. The client should store the raw token and send it within the `Authorization` header during requests.
- Token validation: Hash the token received in the Authorization: Bearer <token> header and look up the matching `user_tokens.token_hash`.
- Expiration check: Verify that `user_tokens.expires_at` is in the future and `user_tokens.revoked_at` is NULL.
- User identification: Retrieve the associated user through `user_tokens.user_id` and verify that the account is active.
- Logout: Revoke the token by updating `user_tokens.revoked_at` to the current timestamp.
- Request Context: Wrap the request handling with Nodejs Async Storage. Use Async storage to inject the the authenticated user object and role into the request context so that it is accessed in all methods and functions within the request lifecycle.

#### Access Control for Endpoints

For simplicity, there are just two roles: `user` and `admin`. These roles are hard-coded to each user on the `users` table.

All authenticated endpoints should assume that the authenticated user has a `user` role by default. If an endpoint needs `admin` role access, the handler for the endpoint should check and throw if a non-admin role is detected.

#### User and Roles Management

This architecture is not focused on user or access control managements. Users will be seeded and assigned to roles during seeding.

#### Security for Endpoints

All endpoints shall implement CORS for origin restriction. For simplicity, outside request authentication, no other request-level security shall be implemented.

#### Transport Mechanisms Between API Service and Frontend Service

- Synchronous API Requests
- Asynchronous Server-Sent Events

#### Global Error Handling

- A global error handling function shall wrap all request handling. If this functionality is provided by Express, such a functionality should be preferred.
- Generic errors shall be translated by the global error handler to 500 responses.
- All request handlers shall prefer throwing errors instead of returning non-2xx/3xx responses by themselves.
- An `Exception` class which receives the status code and error message should be implemented and used for throwing errors within request handlers.
- The global error handler should intercept validation errors from the Vinejs library and relay such errors to the client.

#### Request Validations

The Vinejs library should be used for request validations.

#### Failure and Idempotency Handling

##### Duplicate Payment or Webhook Events Handling

##### Retry Handling

### Message Queue Service Design

The Message Queue Service shall be used primarily to demonstrate an asynchronous sending of email outside of the API service.

- The Message Queue Service will run as a standalone Nodejs server.
- Workmatic (https://github.com/litepacks/workmatic) shall be used for persistent job queue. Workmatic shall use the `jobs.db` database.

For simplicity, the Message Queue Service shall expose only a single endpoint for posting jobs: `POST /jobs`.

### Frontend Service Design

### API Documentation Service Design

### Mock Payment Provider Design

The Mock Payment Provider Service shall be used primarily to simulate a payment provider. It will be responsible for receiving the payment flow submission on the Frontend Service and sending payment status notifications as webhook events to the API service.

- The Mock Payment Provider Service will run as a standalone Nodejs server.
- Workmatic (https://github.com/litepacks/workmatic) shall be used for persistent job queue within the service. Workmatic shall use the `payment_provider.db` database.

For simplicity, the Message Queue Service shall expose only a single endpoint for completing a payment: `POST /payments`. There will be no payment confirmation endpoint to be called by the API service. Verification of the webhook event shall authenticate the webhook request and serve as payment verification if all conditions are met.

The Mock Payment Provider shall accompany all its request to the API service with a signature of the signed request body. A shared token between the API service and Mock Payment Provider service shall be used to generate and verify the signature.

### Miscellaneous Designs

#### Logging Implementation

- The `pino` library should used for request logging.
- A request ID should be generated at the start of the request handling by a middleware and injected into the request context.
- All logs generated by the API service during a request lifecycle should contain the request ID.
- At the end of the request (success or failure), a detailed log of the request should made with `pino` and should reflect the request method, request path, authentication state, authenticated user ID, request timing, status code, request size, and response size.

### Test Gates

#### API Service Test Gate

#### Frontend Service Test Gate

### Deployment

### API Documentation

### Alternatives

### Drawbacks

### Prior Art

### Parts of the System Affected
