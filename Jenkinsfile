// =============================================================================
// Blok Framework - Declarative Jenkins Pipeline
// =============================================================================
// Mirrors the GitHub Actions CI pipeline with Jenkins declarative syntax.
// Requires: Docker Pipeline plugin, NodeJS plugin, Pipeline Utility Steps.
// =============================================================================

pipeline {
    agent {
        docker {
            image 'node:22-alpine'
            args '-u root --privileged'
        }
    }

    environment {
        PNPM_VERSION   = '10.14.0'
        NODE_VERSION   = '22'
        HUSKY          = '0'
        CI             = 'true'
        PNPM_HOME      = "${WORKSPACE}/.pnpm-home"
        PATH           = "${PNPM_HOME}:${env.PATH}"
    }

    options {
        timeout(time: 30, unit: 'MINUTES')
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '20'))
        timestamps()
    }

    stages {
        // -----------------------------------------------------------------
        // Checkout
        // -----------------------------------------------------------------
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        // -----------------------------------------------------------------
        // Install dependencies
        // -----------------------------------------------------------------
        stage('Install') {
            steps {
                sh '''
                    corepack enable
                    corepack prepare pnpm@${PNPM_VERSION} --activate
                    pnpm install --frozen-lockfile
                '''
            }
        }

        // -----------------------------------------------------------------
        // Lint & Format
        // -----------------------------------------------------------------
        stage('Lint') {
            steps {
                sh 'npx biome ci .'
            }
        }

        // -----------------------------------------------------------------
        // Build & Typecheck
        // -----------------------------------------------------------------
        stage('Build') {
            steps {
                sh '''
                    pnpm run build
                    pnpm --filter nanoctl run typecheck
                    pnpm --filter @nanoservice-ts/helper run typecheck
                '''
            }
        }

        // -----------------------------------------------------------------
        // Test (parallel)
        // -----------------------------------------------------------------
        stage('Test') {
            parallel {
                stage('Test Runner') {
                    steps {
                        sh '''
                            pnpm run core:build:dev
                            pnpm --filter @nanoservice-ts/runner run test
                        '''
                    }
                }

                stage('Test CLI') {
                    steps {
                        sh '''
                            pnpm run build:cli
                            pnpm run cli:test
                        '''
                    }
                }

                stage('Test Helper') {
                    steps {
                        sh '''
                            pnpm run core:build:dev
                            pnpm --filter @nanoservice-ts/helper run test
                        '''
                    }
                }

                stage('Test Trigger: cron') {
                    steps {
                        sh '''
                            pnpm run core:build:dev
                            pnpm --filter @nanoservice-ts/trigger-cron run test
                        '''
                    }
                }

                stage('Test Trigger: webhook') {
                    steps {
                        sh '''
                            pnpm run core:build:dev
                            pnpm --filter @nanoservice-ts/trigger-webhook run test
                        '''
                    }
                }

                stage('Test Trigger: websocket') {
                    steps {
                        sh '''
                            pnpm run core:build:dev
                            pnpm --filter @nanoservice-ts/trigger-websocket run test
                        '''
                    }
                }

                stage('Test Trigger: sse') {
                    steps {
                        sh '''
                            pnpm run core:build:dev
                            pnpm --filter @nanoservice-ts/trigger-sse run test
                        '''
                    }
                }

                stage('Test Trigger: queue') {
                    steps {
                        sh '''
                            pnpm run core:build:dev
                            pnpm --filter @nanoservice-ts/trigger-queue run test
                        '''
                    }
                }

                stage('Test Trigger: pubsub') {
                    steps {
                        sh '''
                            pnpm run core:build:dev
                            pnpm --filter @nanoservice-ts/trigger-pubsub run test
                        '''
                    }
                }
            }
        }

        // -----------------------------------------------------------------
        // Integration Tests (Docker Compose services)
        // -----------------------------------------------------------------
        stage('Integration Tests') {
            when {
                branch 'main'
            }
            agent {
                docker {
                    image 'node:22-alpine'
                    args '-u root --privileged -v /var/run/docker.sock:/var/run/docker.sock'
                }
            }
            steps {
                sh '''
                    # Install Docker CLI for Docker Compose
                    apk add --no-cache docker-cli docker-cli-compose

                    # Start integration services
                    docker compose -f infra/testing/docker-compose.yml up -d redis rabbitmq nats
                    echo "Waiting for services to become healthy..."
                    sleep 15

                    # Install and build
                    corepack enable
                    corepack prepare pnpm@${PNPM_VERSION} --activate
                    pnpm install --frozen-lockfile
                    pnpm run build

                    # Run integration tests
                    REDIS_URL=redis://localhost:6380 \
                    RABBITMQ_URL=amqp://blok:blok_test@localhost:5673 \
                    NATS_URL=nats://localhost:4223 \
                    pnpm --filter @nanoservice-ts/runner run test:integration
                '''
            }
            post {
                always {
                    sh 'docker compose -f infra/testing/docker-compose.yml down -v || true'
                }
            }
        }

        // -----------------------------------------------------------------
        // Deploy
        // -----------------------------------------------------------------
        stage('Deploy') {
            when {
                branch 'main'
            }
            stages {
                stage('Deploy Staging') {
                    steps {
                        script {
                            def commitHash = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
                            sh """
                                docker build -t blok:staging-${commitHash} -f dockerfiles/Dockerfile .
                                docker tag blok:staging-${commitHash} blok:staging-latest
                                echo "Staging image built: blok:staging-${commitHash}"
                            """
                        }
                    }
                }

                stage('Deploy Production') {
                    input {
                        message 'Deploy to production?'
                        ok 'Yes, deploy to production'
                        submitter 'admin,release-managers'
                    }
                    steps {
                        script {
                            def commitHash = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
                            sh """
                                docker build -t blok:${commitHash} -f dockerfiles/Dockerfile .
                                docker tag blok:${commitHash} blok:latest
                                echo "Production image built: blok:${commitHash}"
                            """
                        }
                    }
                }
            }
        }
    }

    post {
        always {
            cleanWs()
        }
        failure {
            script {
                echo "Pipeline failed on branch: ${env.BRANCH_NAME}"
                echo "Build URL: ${env.BUILD_URL}"
                // Uncomment and configure for Slack/email notifications:
                // slackSend(
                //     color: 'danger',
                //     message: "FAILED: ${env.JOB_NAME} #${env.BUILD_NUMBER} (<${env.BUILD_URL}|Open>)"
                // )
                // emailext(
                //     subject: "FAILED: ${env.JOB_NAME} #${env.BUILD_NUMBER}",
                //     body: "Build failed. Check ${env.BUILD_URL} for details.",
                //     recipientProviders: [[$class: 'DevelopersRecipientProvider']]
                // )
            }
        }
        success {
            echo 'All CI checks passed!'
        }
    }
}
