import { isSpecialOperation } from './contracts.js'

type OperationState = {
  get: (key: string) => string
  set: (key: string, value: unknown) => OperationState
}

type SwaggerSystem = {
  React: { createElement: (component: unknown, props: Record<string, unknown>) => unknown }
}

export function specialOperationsPlugin(system: SwaggerSystem) {
  return {
    wrapComponents: {
      operation: (Original: unknown) => (props: { operation?: OperationState }) => {
        const operation = props.operation
        if (!operation || !isSpecialOperation(operation.get('method'), operation.get('path'))) return system.React.createElement(Original, props)
        return system.React.createElement(Original, { ...props, operation: operation.set('allowTryItOut', false) })
      },
    },
    components: { authorizeBtn: () => null, authorizeOperationBtn: () => null },
  }
}
