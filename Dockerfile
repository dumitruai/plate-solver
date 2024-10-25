# Stage 1: Build Stage
FROM node:18-alpine AS builder

# Install dependencies
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install all dependencies (including devDependencies for building)
RUN npm install

# Copy the rest of the application code
COPY . .

# Build the TypeScript code
RUN npm run build

# Stage 2: Production Stage
FROM node:18-alpine

# Set environment variables
ENV NODE_ENV=production

# Set the working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install only production dependencies
RUN npm install --only=production

# Copy the compiled JavaScript code from the builder stage
COPY --from=builder /usr/src/app/dist ./dist

# (Optional) Copy any other necessary files (e.g., .env if not using secrets)

# Expose ports if necessary
# Not required for polling-based Telegram bots
# EXPOSE 3000

# Define the default command to run the bot
CMD ["npm", "start"]
