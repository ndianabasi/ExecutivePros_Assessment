# System Architecture / Design Document

## Author: Ndianabasi Udonkang (Senior Software Engineer)

## Email: ndianabasi.udonkang@gmail.com

In partial fulfillment of the ExecutivePro Assessment for Node.js + React Developer Role

## Summary

This system architecture document is focused on the design of a Node.js microservice which safely and reliably handles payment processing requests and provides interfaces for authorised users to review payments.

Four microservices are proposed within this architecture:

1. API Service,
2. Frontend Service,
3. Message Queue Service, and
4. API Documentation Service.

### 1. API Service

The API service is the main application backend. It will be developed with TypeScript for the Nodejs runtime. The API Service will domicile all proposed endpoints to be called from the Frontend Service and will provide authentication, authorisation, and security for all API requests.

### 2. Frontend Service

The Frontend Service will provide the user interface for interacting with the API service and receiving real-time events from the API service.

### 3. Message Queue Service

The Message Queue Service will provide an asynchronous messaging queue which the API Service can publish jobs to for asynchronous processing.

### 4. API Documentation Service

The API Documentation Service will provide an user interface to exploring the functionalities of the endpoints exposed by the API service.

## Reference-Level Explanations

### Architecture / Workflow Overview

The flowchart below presents the relationship between the four (4) proposed microservices. Details of each microservice will be discussed in sections below.

![Microservices Flowchart](microservice_architecture.png)

### Database and Data Models

#### Database Engine

The SQLite database engine will be used for file-based data persistence. In-memory or JSON file persistence recommended in the brief will not be used due the data persistence requirements of the API and Message Queue Services. SQLite meets the simplicity requirements as we are not spawning a full-blown database server like PostgreSQL.

#### Data Models

The following databases and tables will be needed for the operations to be performed by the 4 microservices.

##### Database and Tables Managed by the API Service

Below is a proposed relational database schema for `api.db`, using **SQLite-compatible data types** and constraints.

The schema includes the four requested tables, plus a `cart_items` table to support carts containing multiple products.

###### 1.`api.db / users`

The `users` table stores basic information about users who are authenticated or authorised to perform API operations.

| Name            | Data Type | Constraints                                                   | Description                                                      |
| --------------- | --------- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| `id`            | INTEGER   | PRIMARY KEY, AUTOINCREMENT                                    | Unique identifier for each user.                                 |
| `first_name`    | TEXT      | NOT NULL                                                      | User's first name.                                               |
| `last_name`     | TEXT      | NOT NULL                                                      | User's last name.                                                |
| `email`         | TEXT      | NOT NULL, UNIQUE                                              | User's email address, used for authentication and communication. |
| `password_hash` | TEXT      | NOT NULL                                                      | Securely hashed password used for authentication.                |
| `role`          | TEXT      | NOT NULL, DEFAULT 'user', CHECK (`role IN ('user', 'admin')`) | Determines the user's authorisation level.                       |
| `is_active`     | INTEGER   | NOT NULL, DEFAULT 1, CHECK (`is_active IN (0, 1)`)            | Indicates whether the user's account is active.                  |
| `created_at`    | TEXT      | NOT NULL, DEFAULT CURRENT_TIMESTAMP                           | Timestamp when the user account was created.                     |
| `updated_at`    | TEXT      | NOT NULL, DEFAULT CURRENT_TIMESTAMP                           | Timestamp when the user account was last updated.                |

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

###### 6. Database relationships

Simplified entity relationship diagram. N = many.

The schema supports these relationships:

- **Users -> Carts:** One user can own multiple carts.
- **Users -> Payments:** One user can initiate multiple payments.
- **Carts -> Payments:** One cart can have multiple payment attempts.
- **Carts -> Cart Items:** One cart can contain multiple cart items.
- **Products -> Cart Items:** One product can appear in multiple carts.

##### Database to be Managed by the Message Queue Service

###### 1. `jobs.db` Database

The tables within the `jobs.db` database will be managed internally by the Message Queue Service, and as such, will not be discussed here.

### API Service Design

#### Required Endpoints

#### Authentication for Endpoints

#### Access Control for Endpoints

#### Security for Endpoints

#### Transport Mechanisms Between API Service and Frontend Service

- Synchronous API Requests
- Asynchronous Server-Sent Events

#### State and Integrity Logic

#### Failure and Idempotency Analysis

##### Duplicate Payment or Webhook Events

##### Retry Handling

### Message Queue Service Design

### Frontend Service Design

### API Documentation Service Design

### Miscellaneous Designs

#### Logging Service

#### Global Error Handling

### Test Gates

#### API Service Test Gate

#### Frontend Service Test Gate

### Deployment

### API Documentation

### Alternatives

### Drawbacks

### Prior Art

### Parts of the System Affected
