---
name: react-component
description: Best practices for React component development
paths: ["**/*.tsx", "**/*.jsx", "**/components/**"]
setup:
  help: "This skill works best with TypeScript React projects"
  collect_secrets:
    - env_var: REACT_APP_API_URL
      prompt: "Enter your React app API base URL"
      provider_url: "https://create-react-app.dev/docs/adding-custom-environment-variables/"
      secret: false
---

# React Component Development Guide

## Component Structure

```tsx
import React from 'react';

interface Props {
  title: string;
  children?: React.ReactNode;
}

export const MyComponent: React.FC<Props> = ({ title, children }) => {
  return (
    <div className="my-component">
      <h1>{title}</h1>
      {children}
    </div>
  );
};
```

## Best Practices

1. **Use TypeScript** for type safety
2. **Functional components** with hooks (avoid class components)
3. **Props interface** always defined
4. **Memoization** with `React.memo()` for expensive renders
5. **Custom hooks** for reusable logic

## Common Patterns

### useEffect with cleanup
```tsx
useEffect(() => {
  const subscription = subscribe();
  return () => subscription.unsubscribe();
}, []);
```

### Conditional rendering
```tsx
{isLoading ? <Spinner /> : <Content data={data} />}
```

## Environment Variables

Access API URL from environment:
```tsx
const apiUrl = process.env.REACT_APP_API_URL;
```
