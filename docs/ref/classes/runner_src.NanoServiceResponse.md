[blok - v0.1.0](../README.md) / [runner/src](../modules/runner_src.md) / BlokResponse

# Class: BlokResponse

[runner/src](../modules/runner_src.md).BlokResponse

## Implements

- [`IBlokResponse`](../interfaces/runner_src.IBlokResponse.md)

## Table of contents

### Constructors

- [constructor](runner_src.BlokResponse.md#constructor)

### Properties

- [contentType](runner_src.BlokResponse.md#contenttype)
- [data](runner_src.BlokResponse.md#data)
- [error](runner_src.BlokResponse.md#error)
- [steps](runner_src.BlokResponse.md#steps)
- [success](runner_src.BlokResponse.md#success)

### Methods

- [setError](runner_src.BlokResponse.md#seterror)
- [setSteps](runner_src.BlokResponse.md#setsteps)
- [setSuccess](runner_src.BlokResponse.md#setsuccess)

## Constructors

### constructor

• **new BlokResponse**(): [`BlokResponse`](runner_src.BlokResponse.md)

#### Returns

[`BlokResponse`](runner_src.BlokResponse.md)

#### Defined in

[core/runner/src/BlokResponse.ts:15](https://github.com/deskree-inc/blok/blob/fd59582/core/runner/src/BlokResponse.ts#L15)

## Properties

### contentType

• `Optional` **contentType**: `string`

#### Defined in

[core/runner/src/BlokResponse.ts:13](https://github.com/deskree-inc/blok/blob/fd59582/core/runner/src/BlokResponse.ts#L13)

___

### data

• **data**: `string` \| [`JsonLikeObject`](../interfaces/runner_src.JsonLikeObject.md) \| [`JsonLikeObject`](../interfaces/runner_src.JsonLikeObject.md)[]

#### Defined in

[core/runner/src/BlokResponse.ts:10](https://github.com/deskree-inc/blok/blob/fd59582/core/runner/src/BlokResponse.ts#L10)

___

### error

• **error**: `any`

#### Defined in

[core/runner/src/BlokResponse.ts:11](https://github.com/deskree-inc/blok/blob/fd59582/core/runner/src/BlokResponse.ts#L11)

___

### steps

• **steps**: `NodeBase`[]

#### Implementation of

[IBlokResponse](../interfaces/runner_src.IBlokResponse.md).[steps](../interfaces/runner_src.IBlokResponse.md#steps)

#### Defined in

[core/runner/src/BlokResponse.ts:9](https://github.com/deskree-inc/blok/blob/fd59582/core/runner/src/BlokResponse.ts#L9)

___

### success

• `Optional` **success**: `boolean`

#### Defined in

[core/runner/src/BlokResponse.ts:12](https://github.com/deskree-inc/blok/blob/fd59582/core/runner/src/BlokResponse.ts#L12)

## Methods

### setError

▸ **setError**(`error`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `error` | `GlobalError` |

#### Returns

`void`

#### Defined in

[core/runner/src/BlokResponse.ts:23](https://github.com/deskree-inc/blok/blob/fd59582/core/runner/src/BlokResponse.ts#L23)

___

### setSteps

▸ **setSteps**(`steps`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `steps` | `NodeBase`[] |

#### Returns

`void`

#### Defined in

[core/runner/src/BlokResponse.ts:35](https://github.com/deskree-inc/blok/blob/fd59582/core/runner/src/BlokResponse.ts#L35)

___

### setSuccess

▸ **setSuccess**(`data`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `string` \| [`JsonLikeObject`](../interfaces/runner_src.JsonLikeObject.md) \| [`JsonLikeObject`](../interfaces/runner_src.JsonLikeObject.md)[] |

#### Returns

`void`

#### Defined in

[core/runner/src/BlokResponse.ts:29](https://github.com/deskree-inc/blok/blob/fd59582/core/runner/src/BlokResponse.ts#L29)
