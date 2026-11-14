import { isSpecialOperation } from './contracts.js'

type OperationState = {
  get: (key: string) => string
  set: (key: string, value: unknown) => OperationState
}

type SwaggerSystem = {
  React: { createElement: (component: unknown, props: Record<string, unknown>) => unknown }
}

/**
 * Adds request validation and assessment-demo controls to Swagger UI for operations that need custom handling.
 *
 * @param system - OpenAPI system object inspected for an operation or schema capability.
 */
export function specialOperationsPlugin(system: SwaggerSystem) {
  return {
    wrapComponents: {
      operation: (Original: unknown) => {
        return (props: { operation?: OperationState }) => {
          const operation = props.operation
          if (!operation || !isSpecialOperation(operation.get('method'), operation.get('path'))) {
            return system.React.createElement(Original, props)
          }
          return system.React.createElement(Original, {
            ...props,
            operation: operation.set('allowTryItOut', false),
          })
        }
      },
    },
    components: {
      authorizeBtn: () => {
        return null
      },
      authorizeOperationBtn: () => {
        return null
      },
    },
  }
}
