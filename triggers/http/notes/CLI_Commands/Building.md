# BlokService CLI Commands: Build

## Table of Contents
- [Build Blok ](#build-blok)
  - [Syntax](#build-syntax)
  - [Options](#build-options)
  - [Examples](#build-examples)
- [Deploy Blok ](#deploy-blok)
  - [Syntax](#deploy-syntax)
  - [Options](#deploy-options)
  - [Examples](#deploy-examples)
- [Common Examples](#common-examples)
- [Troubleshooting](#troubleshooting)

---

## Build Blok 

### Syntax
```bash
npx blokctl build [options]
```
  Compiles and packages a blok from source code into a deployable artifact.
 
  ### Options
  | Option       | Alias | Type    | Description                | Default            |
  |--------------|-------|---------|----------------------------|--------------------|
  | `--directory`| `-d`  | string  | Source directory path      | `./blok` |
  | `--help`     | `-h`  | boolean | Show help                  | `false`            |
 
  ### Commands
  | Command | Description               |
  |---------|---------------------------|
  | `.`     | Build in current directory|
 
  ### Examples
  #### Build in default directory:
  ``` bash
  npx blokctl build
  ```
  #### Build in specific directory:
  ```bash
  npx blokctl build -d ./my-blok
  ```

  #### Build in current directory:
  ```bash
  npx blokctl build .
  ```

---
> **Note**: After executing the building command, you can proceed to deploy the blok using the [deploy](./Deployment.md) command.