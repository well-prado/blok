[blok - v0.1.0](../README.md) / [runner/src](../modules/runner_src.md) / BlokService

# Class: BlokService\<T\>

[runner/src](../modules/runner_src.md).BlokService

## Type parameters

| Name |
| :------ |
| `T` |

## Hierarchy

- `unknown`

  ↳ **`BlokService`**

## Table of contents

### Constructors

- [constructor](runner_src.BlokService.md#constructor)

### Properties

- [inputSchema](runner_src.BlokService.md#inputschema)
- [outputSchema](runner_src.BlokService.md#outputschema)
- [v](runner_src.BlokService.md#v)

### Methods

- [getSchemas](runner_src.BlokService.md#getschemas)
- [handle](runner_src.BlokService.md#handle)
- [run](runner_src.BlokService.md#run)
- [setSchemas](runner_src.BlokService.md#setschemas)
- [validate](runner_src.BlokService.md#validate)

## Constructors

### constructor

• **new BlokService**\<`T`\>(): [`BlokService`](runner_src.BlokService.md)\<`T`\>

#### Type parameters

| Name |
| :------ |
| `T` |

#### Returns

[`BlokService`](runner_src.BlokService.md)\<`T`\>

#### Overrides

NodeBase.constructor

#### Defined in

[core/runner/src/BlokService.ts:17](https://github.com/deskree-inc/blok/blob/fd59582/core/runner/src/BlokService.ts#L17)

## Properties

### inputSchema

• **inputSchema**: `Schema`

#### Defined in

[core/runner/src/BlokService.ts:13](https://github.com/deskree-inc/blok/blob/fd59582/core/runner/src/BlokService.ts#L13)

___

### outputSchema

• **outputSchema**: `Schema`

#### Defined in

[core/runner/src/BlokService.ts:14](https://github.com/deskree-inc/blok/blob/fd59582/core/runner/src/BlokService.ts#L14)

___

### v

• `Private` **v**: `Validator`

#### Defined in

[core/runner/src/BlokService.ts:15](https://github.com/deskree-inc/blok/blob/fd59582/core/runner/src/BlokService.ts#L15)

## Methods

### getSchemas

▸ **getSchemas**(): `Object`

#### Returns

`Object`

| Name | Type |
| :------ | :------ |
| `input` | `Schema` |
| `output` | `Schema` |

#### Defined in

[core/runner/src/BlokService.ts:29](https://github.com/deskree-inc/blok/blob/fd59582/core/runner/src/BlokService.ts#L29)

___

### handle

▸ **handle**(`ctx`, `inputs`): `Promise`\<[`IBlokResponse`](../interfaces/runner_src.IBlokResponse.md) \| [`BlokService`](runner_src.BlokService.md)\<`T`\>[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `ctx` | `Context` |
| `inputs` | [`JsonLikeObject`](../interfaces/runner_src.JsonLikeObject.md) \| `T` \| [`Condition`](../modules/runner_src.md#condition)[] |

#### Returns

`Promise`\<[`IBlokResponse`](../interfaces/runner_src.IBlokResponse.md) \| [`BlokService`](runner_src.BlokService.md)\<`T`\>[]\>

#### Defined in

[core/runner/src/BlokService.ts:99](https://github.com/deskree-inc/blok/blob/fd59582/core/runner/src/BlokService.ts#L99)

___

### run

▸ **run**(`ctx`): `Promise`\<`ResponseContext`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `ctx` | `Context` |

#### Returns

`Promise`\<`ResponseContext`\>

#### Defined in

[core/runner/src/BlokService.ts:36](https://github.com/deskree-inc/blok/blob/fd59582/core/runner/src/BlokService.ts#L36)

___

### setSchemas

▸ **setSchemas**(`input`, `output`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `input` | `Schema` |
| `output` | `Schema` |

#### Returns

`void`

#### Defined in

[core/runner/src/BlokService.ts:24](https://github.com/deskree-inc/blok/blob/fd59582/core/runner/src/BlokService.ts#L24)

___

### validate

▸ **validate**(`obj`, `schema`): `Promise`\<`void`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `obj` | [`JsonLikeObject`](../interfaces/runner_src.JsonLikeObject.md) |
| `schema` | `Schema` |

#### Returns

`Promise`\<`void`\>

#### Defined in

[core/runner/src/BlokService.ts:104](https://github.com/deskree-inc/blok/blob/fd59582/core/runner/src/BlokService.ts#L104)
