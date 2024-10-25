# Dockerfile
# Use the official Node.js 18 image as the base
FROM node:18-alpine

# Create and set the working directory
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the application code
COPY . .

# Build TypeScript code
RUN npm run build

# Expose the port (Cloud Run uses PORT environment variable)
ENV PORT=8080
EXPOSE 8080

# Start the application
CMD ["node", "dist/index.js"]