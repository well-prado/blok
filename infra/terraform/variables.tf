###############################################################################
# Blok Framework - Terraform Variables
###############################################################################

# -----------------------------------------------------------------------------
# General
# -----------------------------------------------------------------------------

variable "environment" {
  description = "Deployment environment (dev, staging, prod)"
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Environment must be one of: dev, staging, prod."
  }
}

variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-east-1"
}

variable "app_name" {
  description = "Application name used as a prefix for all resources"
  type        = string
  default     = "blok"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.app_name))
    error_message = "App name must be lowercase alphanumeric with hyphens, 2-21 characters."
  }
}

# -----------------------------------------------------------------------------
# Networking
# -----------------------------------------------------------------------------

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0))
    error_message = "VPC CIDR must be a valid IPv4 CIDR block."
  }
}

variable "az_count" {
  description = "Number of availability zones to use"
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 4
    error_message = "AZ count must be between 2 and 4 for high availability."
  }
}

# -----------------------------------------------------------------------------
# Container Configuration
# -----------------------------------------------------------------------------

variable "image_tag" {
  description = "Docker image tag to deploy"
  type        = string
  default     = "latest"
}

variable "container_port" {
  description = "Port the Blok application listens on"
  type        = number
  default     = 4000

  validation {
    condition     = var.container_port > 0 && var.container_port <= 65535
    error_message = "Container port must be between 1 and 65535."
  }
}

variable "metrics_port" {
  description = "Port for Prometheus metrics endpoint"
  type        = number
  default     = 9091

  validation {
    condition     = var.metrics_port > 0 && var.metrics_port <= 65535
    error_message = "Metrics port must be between 1 and 65535."
  }
}

variable "task_cpu" {
  description = "CPU units for the ECS task (1 vCPU = 1024 units)"
  type        = number
  default     = 512

  validation {
    condition     = contains([256, 512, 1024, 2048, 4096], var.task_cpu)
    error_message = "Task CPU must be one of: 256, 512, 1024, 2048, 4096."
  }
}

variable "task_memory" {
  description = "Memory in MiB for the ECS task"
  type        = number
  default     = 1024

  validation {
    condition     = var.task_memory >= 512 && var.task_memory <= 30720
    error_message = "Task memory must be between 512 and 30720 MiB."
  }
}

variable "cpu_architecture" {
  description = "CPU architecture for the Fargate task (X86_64 or ARM64)"
  type        = string
  default     = "X86_64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "CPU architecture must be X86_64 or ARM64."
  }
}

# -----------------------------------------------------------------------------
# Scaling
# -----------------------------------------------------------------------------

variable "desired_count" {
  description = "Desired number of ECS tasks"
  type        = number
  default     = 2

  validation {
    condition     = var.desired_count >= 1
    error_message = "Desired count must be at least 1."
  }
}

variable "min_count" {
  description = "Minimum number of ECS tasks for auto-scaling"
  type        = number
  default     = 1

  validation {
    condition     = var.min_count >= 1
    error_message = "Minimum count must be at least 1."
  }
}

variable "max_count" {
  description = "Maximum number of ECS tasks for auto-scaling"
  type        = number
  default     = 10

  validation {
    condition     = var.max_count >= 1
    error_message = "Maximum count must be at least 1."
  }
}

variable "cpu_scaling_target" {
  description = "Target CPU utilization percentage for auto-scaling"
  type        = number
  default     = 70

  validation {
    condition     = var.cpu_scaling_target > 0 && var.cpu_scaling_target <= 100
    error_message = "CPU scaling target must be between 1 and 100."
  }
}

variable "memory_scaling_target" {
  description = "Target memory utilization percentage for auto-scaling"
  type        = number
  default     = 75

  validation {
    condition     = var.memory_scaling_target > 0 && var.memory_scaling_target <= 100
    error_message = "Memory scaling target must be between 1 and 100."
  }
}

variable "requests_scaling_target" {
  description = "Target ALB request count per target for auto-scaling"
  type        = number
  default     = 1000

  validation {
    condition     = var.requests_scaling_target > 0
    error_message = "Requests scaling target must be greater than 0."
  }
}

# -----------------------------------------------------------------------------
# Feature Flags
# -----------------------------------------------------------------------------

variable "enable_redis" {
  description = "Enable ElastiCache Redis for caching and pub/sub"
  type        = bool
  default     = false
}

variable "enable_monitoring" {
  description = "Enable enhanced monitoring with CloudWatch alarms and Container Insights"
  type        = bool
  default     = true
}

# -----------------------------------------------------------------------------
# Redis Configuration
# -----------------------------------------------------------------------------

variable "redis_node_type" {
  description = "ElastiCache Redis node type"
  type        = string
  default     = "cache.t3.micro"
}

# -----------------------------------------------------------------------------
# Logging
# -----------------------------------------------------------------------------

variable "log_retention_days" {
  description = "CloudWatch log retention period in days"
  type        = number
  default     = 30

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "Log retention must be a valid CloudWatch retention value."
  }
}

# -----------------------------------------------------------------------------
# Load Balancer
# -----------------------------------------------------------------------------

variable "alb_access_logs_bucket" {
  description = "S3 bucket name for ALB access logs (empty string to disable)"
  type        = string
  default     = ""
}

# -----------------------------------------------------------------------------
# Extra Environment Variables
# -----------------------------------------------------------------------------

variable "extra_environment_variables" {
  description = "Additional environment variables to pass to the container"
  type = list(object({
    name  = string
    value = string
  }))
  default = []
}
