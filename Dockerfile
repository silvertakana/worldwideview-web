# Step 1: Build the static Next.js application
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies first (caching layer)
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable pnpm
RUN pnpm i --frozen-lockfile

# Copy the rest of the application code
COPY . .

# Build the Next.js static export
RUN pnpm run build

# Step 2: Serve the application using Nginx
FROM nginx:alpine

# Copy the static export directory to Nginx's HTML folder
COPY --from=builder /app/out /usr/share/nginx/html

# Copy the custom Nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose port 80
EXPOSE 80

# Start Nginx
CMD ["nginx", "-g", "daemon off;"]
