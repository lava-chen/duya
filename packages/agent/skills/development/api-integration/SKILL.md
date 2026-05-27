---
name: api-integration
description: "Integrate with third-party APIs effectively. Use when connecting to external services, handling authentication, implementing retries, or managing rate limits. Covers API documentation reading, error handling, and production-ready integration patterns."
---

# API Integration

A systematic approach to integrating with third-party APIs that handles the common challenges of external dependencies.

---

## Core Principle

**APIs are contracts with external parties. Understand the contract thoroughly before writing code.**

---

## Phase 1: API Discovery & Evaluation

### Documentation Reading Strategy

```
DOCUMENTATION READING ORDER

1. Quick Start / Getting Started
   - What's the simplest successful request?
   - What are the prerequisites?

2. Authentication
   - How do you get credentials?
   - How do you use them?
   - What are the limitations?

3. Core Concepts
   - Key terminology
   - Data models
   - Relationships

4. Rate Limits & Quotas
   - What are the limits?
   - What happens when exceeded?
   - How to monitor usage?

5. Error Handling
   - Error codes
   - Error formats
   - Recovery strategies

6. Reference
   - Endpoint details
   - Parameter specifications
   - Response schemas
```

### API Evaluation Checklist

```
API QUALITY ASSESSMENT

Documentation:
□ Complete and accurate
□ Has examples
□ Interactive (Swagger/Postman)
□ Changelog maintained

Reliability:
□ Uptime SLA
□ Status page available
□ Historical reliability

Support:
□ Community forums
□ Official support channels
□ Response times

Maturity:
□ Versioning strategy
□ Deprecation policy
□ Breaking change handling
```

---

## Phase 2: Authentication

### Auth Patterns

```
AUTHENTICATION TYPES

API Key:
- Header: `X-API-Key: your_key`
- Query param: `?api_key=your_key`
- Simple but limited security

OAuth 2.0:
- Authorization code flow (user apps)
- Client credentials (server-to-server)
- Refresh tokens for long-term access

JWT:
- Self-contained tokens
- Contains claims/permissions
- Expires, needs refresh

Basic Auth:
- Username:password in header
- Only over HTTPS
- Simple but less secure
```

### Credential Management

```
SECURITY PRACTICES

Storage:
□ Never hardcode credentials
□ Use environment variables
□ Use secret management (AWS Secrets Manager, etc.)
□ Rotate credentials regularly

Usage:
□ HTTPS only
□ Don't log credentials
□ Validate SSL certificates
□ Scope permissions minimally
```

---

## Phase 3: Request Implementation

### HTTP Client Setup

```
CLIENT CONFIGURATION

Timeout settings:
- Connection timeout: 10s
- Request timeout: 30s
- Read timeout: 60s

Retry configuration:
- Max retries: 3
- Backoff: exponential
- Retry on: 5xx, timeout, connection errors
- Don't retry: 4xx (client errors)

Connection pooling:
- Reuse connections
- Max connections per host
- Connection keep-alive
```

### Request Pattern

```javascript
// Example: Robust API request pattern
async function makeApiRequest(endpoint, options = {}) {
  const config = {
    timeout: 30000,
    retries: 3,
    retryDelay: 1000,
    ...options
  };
  
  let lastError;
  
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    try {
      const response = await fetch(endpoint, {
        headers: {
          'Authorization': `Bearer ${getToken()}`,
          'Content-Type': 'application/json',
        },
        timeout: config.timeout,
        ...config.fetchOptions
      });
      
      if (!response.ok) {
        throw new ApiError(response.status, await response.text());
      }
      
      return await response.json();
      
    } catch (error) {
      lastError = error;
      
      // Don't retry client errors
      if (error.status >= 400 && error.status < 500) {
        throw error;
      }
      
      // Wait before retry
      if (attempt < config.retries) {
        await delay(config.retryDelay * Math.pow(2, attempt));
      }
    }
  }
  
  throw lastError;
}
```

---

## Phase 4: Error Handling

### Error Categories

```
ERROR TYPES

Client errors (4xx):
400 - Bad Request: Check request format
401 - Unauthorized: Check authentication
403 - Forbidden: Check permissions
404 - Not Found: Check resource exists
429 - Rate Limited: Back off and retry

Server errors (5xx):
500 - Internal Error: Retry with backoff
502 - Bad Gateway: Temporary, retry
503 - Service Unavailable: Retry later
504 - Gateway Timeout: Retry

Network errors:
Timeout: Retry with backoff
Connection refused: Check URL/network
DNS failure: Check domain
SSL error: Check certificates
```

### Error Handling Pattern

```javascript
class ApiError extends Error {
  constructor(status, message, response) {
    super(message);
    this.status = status;
    this.response = response;
    this.isRetryable = status >= 500 || status === 429;
  }
}

async function handleApiCall() {
  try {
    return await makeApiRequest('/endpoint');
  } catch (error) {
    if (error instanceof ApiError) {
      switch (error.status) {
        case 401:
          // Refresh token and retry
          await refreshToken();
          return await makeApiRequest('/endpoint');
          
        case 429:
          // Rate limited, wait and retry
          const retryAfter = error.response.headers.get('Retry-After');
          await delay(retryAfter * 1000);
          return await makeApiRequest('/endpoint');
          
        case 404:
          // Resource not found
          return null;
          
        default:
          if (error.isRetryable) {
            // Already retried, fail
            throw error;
          }
          // Client error, don't retry
          throw error;
      }
    }
    throw error;
  }
}
```

---

## Phase 5: Rate Limiting

### Rate Limit Handling

```
RATE LIMIT STRATEGIES

Prevention:
□ Track usage
□ Implement client-side throttling
□ Cache responses
□ Batch requests

Detection:
□ Check rate limit headers
□ Monitor 429 responses
□ Track quota usage

Response:
□ Exponential backoff
□ Respect Retry-After header
□ Queue requests
□ Circuit breaker pattern
```

### Rate Limit Headers

```
COMMON HEADER PATTERNS

Standard:
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1640995200

GitHub:
X-RateLimit-Limit: 5000
X-RateLimit-Remaining: 4999
X-RateLimit-Reset: 1640995200
X-RateLimit-Used: 1

With Retry-After:
Retry-After: 60 (seconds)
```

---

## Phase 6: Production Considerations

### Monitoring

```
MONITORING CHECKLIST

Metrics to track:
□ Request volume
□ Response times (p50, p95, p99)
□ Error rates by status code
□ Rate limit hits
□ Token refresh events

Alerts for:
□ Error rate > threshold
□ Response time > threshold
□ Rate limit approaching
□ Authentication failures
```

### Circuit Breaker Pattern

```javascript
class CircuitBreaker {
  constructor(threshold = 5, timeout = 60000) {
    this.failureCount = 0;
    this.threshold = threshold;
    this.timeout = timeout;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.nextAttempt = Date.now();
  }
  
  async execute(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        throw new Error('Circuit breaker is OPEN');
      }
      this.state = 'HALF_OPEN';
    }
    
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
  
  onSuccess() {
    this.failureCount = 0;
    this.state = 'CLOSED';
  }
  
  onFailure() {
    this.failureCount++;
    if (this.failureCount >= this.threshold) {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.timeout;
    }
  }
}

// Usage
const breaker = new CircuitBreaker();
const result = await breaker.execute(() => api.call());
```

---

## Phase 7: Testing

### Testing Strategy

```
TESTING APPROACHES

Unit tests:
□ Mock API responses
□ Test error handling
□ Test retry logic
□ Test rate limiting

Integration tests:
□ Test against sandbox/staging
□ Verify auth flow
□ Check error scenarios
□ Validate response parsing

Contract tests:
□ Verify API schema
□ Check for breaking changes
□ Monitor deprecation warnings
```

### Mocking Pattern

```javascript
// Jest example
jest.mock('./api-client', () => ({
  fetchUser: jest.fn()
}));

describe('UserService', () => {
  it('handles API errors gracefully', async () => {
    fetchUser.mockRejectedValue(new ApiError(500, 'Server error'));
    
    const result = await userService.getUser(123);
    
    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalled();
  });
  
  it('retries on rate limit', async () => {
    fetchUser
      .mockRejectedValueOnce(new ApiError(429, 'Rate limited'))
      .mockResolvedValueOnce({ id: 123, name: 'John' });
    
    const result = await userService.getUser(123);
    
    expect(fetchUser).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ id: 123, name: 'John' });
  });
});
```

---

## Quick Reference

```
INTEGRATION CHECKLIST
□ API documentation reviewed
□ Authentication implemented
□ Error handling in place
□ Retry logic configured
□ Rate limiting handled
□ Timeouts set
□ Monitoring added
□ Tests written

ERROR HANDLING PRIORITY
1. Network errors → Retry with backoff
2. 5xx errors → Retry with backoff
3. 429 → Respect Retry-After, retry
4. 401 → Refresh token, retry once
5. 4xx → Don't retry, log and fail

PRODUCTION READINESS
□ Circuit breaker implemented
□ Metrics collected
□ Alerts configured
□ Logging comprehensive
□ Token refresh automated
□ Sandbox tested
□ Documentation updated
```
