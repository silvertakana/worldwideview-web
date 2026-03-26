# Step 1: Build the static Next.js application
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (caching layer)
COPY package.json package-lock.json* ./
RUN npm ci

# Copy the rest of the application code
COPY . .

# Build the Next.js static export
RUN npm run build

# Step 2: Serve the application using Nginx
FROM nginx:alpine

# Copy the static export directory to Nginx's HTML folder
COPY --from=builder /app/out /usr/share/nginx/html

# Expose port 80
EXPOSE 80

# Start Nginx
CMD ["nginx", "-g", "daemon off;"]
