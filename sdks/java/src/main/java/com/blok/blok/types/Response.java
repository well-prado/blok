package com.blok.blok.types;

import java.util.Objects;

/**
 * Represents the workflow response.
 */
public class Response {

    private Object data;
    private String contentType;
    private boolean success;
    private Object error;

    public Response() {
    }

    // Getters and setters

    public Object getData() {
        return data;
    }

    public void setData(Object data) {
        this.data = data;
    }

    public String getContentType() {
        return contentType;
    }

    public void setContentType(String contentType) {
        this.contentType = contentType;
    }

    public boolean isSuccess() {
        return success;
    }

    public void setSuccess(boolean success) {
        this.success = success;
    }

    public Object getError() {
        return error;
    }

    public void setError(Object error) {
        this.error = error;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || getClass() != o.getClass()) return false;
        Response response = (Response) o;
        return success == response.success &&
                Objects.equals(data, response.data) &&
                Objects.equals(contentType, response.contentType) &&
                Objects.equals(error, response.error);
    }

    @Override
    public int hashCode() {
        return Objects.hash(data, contentType, success, error);
    }

    @Override
    public String toString() {
        return "Response{" +
                "data=" + data +
                ", contentType='" + contentType + '\'' +
                ", success=" + success +
                ", error=" + error +
                '}';
    }
}
