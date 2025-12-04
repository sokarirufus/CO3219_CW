# web/Dockerfile
FROM node:18

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the app
COPY . .

# Vite dev server port
EXPOSE 5173

# Run Vite dev server, accessible from host
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]
