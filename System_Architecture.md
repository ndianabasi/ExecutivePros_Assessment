# System Architecture / Design Document

## Author: Ndianabasi Udonkang (Senior Software Engineer)

## Email: ndianabasi.udonkang@gmail.com

In partial fulfillment of the ExecutivePro Assessment for Node.js + React Developer Role

## Summary

This system architecture document is focused on the design of a Node.js microservice which safely and reliably handles payment processing requests and provides interfaces for authorised users to review payments.

Four microservices are proposed within this architecture:

1. API Service,
2. Message Queue Service,
3. Frontend Service, and
4. API Documentation Service.

## Reference-Level Explanations

### Architecture / Workflow Overview

![Microservices Flowchart](microservice_architecture.png)

### Database and Data Models

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
