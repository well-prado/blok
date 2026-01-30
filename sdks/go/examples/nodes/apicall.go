package nodes

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	blok "github.com/nickincloud/blok-go"
)

// ApiCallNode makes HTTP requests to external APIs.
//
// Config:
//   - url (string, required): The URL to call
//   - method (string, optional): HTTP method (default: GET)
//   - headers (map[string]string, optional): Additional headers
//   - timeout (number, optional): Timeout in seconds (default: 10)
//
// Input (request body):
//   - body (any, optional): Request body for POST/PUT/PATCH
//
// Output:
//   - status (number): HTTP status code
//   - data (any): Parsed response body
//   - headers (map[string]string): Response headers
type ApiCallNode struct{}

// Execute performs the HTTP request.
func (n *ApiCallNode) Execute(ctx *blok.Context, config map[string]interface{}) (interface{}, error) {
	// Get URL from config (required)
	url, ok := config["url"].(string)
	if !ok || url == "" {
		return nil, blok.NewConfigurationError("'url' is required in node config")
	}

	// Get method from config, default to GET
	method := "GET"
	if v, ok := config["method"].(string); ok && v != "" {
		method = strings.ToUpper(v)
	}

	// Get timeout from config, default to 10 seconds
	timeout := 10
	if v, ok := config["timeout"].(float64); ok && v > 0 {
		timeout = int(v)
	}

	// Prepare request body
	var reqBody io.Reader
	if body := ctx.Request.BodyMap(); body != nil {
		if bodyData, exists := body["body"]; exists && bodyData != nil {
			jsonData, err := json.Marshal(bodyData)
			if err != nil {
				return nil, blok.NewExecutionError("failed to marshal request body", err)
			}
			reqBody = bytes.NewBuffer(jsonData)
		}
	}

	// Create HTTP request
	req, err := http.NewRequest(method, url, reqBody)
	if err != nil {
		return nil, blok.NewNetworkError(fmt.Sprintf("failed to create request to %s", url), err)
	}

	// Set headers from config
	if headers, ok := config["headers"].(map[string]interface{}); ok {
		for k, v := range headers {
			if s, ok := v.(string); ok {
				req.Header.Set(k, s)
			}
		}
	}

	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	// Execute request
	client := &http.Client{
		Timeout: time.Duration(timeout) * time.Second,
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, blok.NewNetworkError(fmt.Sprintf("request to %s failed", url), err)
	}
	defer resp.Body.Close()

	// Read response body
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, blok.NewNetworkError("failed to read response body", err)
	}

	// Try to parse as JSON, fall back to string
	var responseData interface{}
	if err := json.Unmarshal(respBody, &responseData); err != nil {
		responseData = string(respBody)
	}

	// Collect response headers
	respHeaders := make(map[string]string)
	for k := range resp.Header {
		respHeaders[k] = resp.Header.Get(k)
	}

	return map[string]interface{}{
		"status":  resp.StatusCode,
		"data":    responseData,
		"headers": respHeaders,
	}, nil
}
