import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';

export interface User {
  id: string;
  email: string;
  password: string; // hashed
  name?: string;
  createdAt: Date;
}

// File path for persistent storage
const USERS_FILE = path.join(process.cwd(), '.users.json');

// Load users from file
function loadUsers(): Map<string, User> {
  const users = new Map<string, User>();
  
  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = fs.readFileSync(USERS_FILE, 'utf-8');
      const usersArray = JSON.parse(data);
      
      usersArray.forEach((user: any) => {
        // Convert createdAt back to Date
        users.set(user.id, {
          ...user,
          createdAt: new Date(user.createdAt),
        });
      });
    }
  } catch (error) {
    console.error('Error loading users:', error);
  }
  
  return users;
}

// Save users to file
function saveUsers(users: Map<string, User>): void {
  try {
    const usersArray = Array.from(users.values()).map(user => ({
      ...user,
      createdAt: user.createdAt.toISOString(), // Convert Date to string for JSON
    }));
    
    fs.writeFileSync(USERS_FILE, JSON.stringify(usersArray, null, 2), 'utf-8');
  } catch (error) {
    console.error('Error saving users:', error);
  }
}

// Initialize users from file
let users: Map<string, User> = loadUsers();

export async function createUser(email: string, password: string, name?: string): Promise<User> {
  // Check if user already exists
  for (const user of users.values()) {
    if (user.email.toLowerCase() === email.toLowerCase()) {
      throw new Error('User already exists');
    }
  }

  // Hash password
  const hashedPassword = await bcrypt.hash(password, 10);

  // Create user
  const user: User = {
    id: `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    email: email.toLowerCase(),
    password: hashedPassword,
    name,
    createdAt: new Date(),
  };

  users.set(user.id, user);
  saveUsers(users); // Persist to file
  return user;
}

export async function findUserByEmail(email: string): Promise<User | null> {
  for (const user of users.values()) {
    if (user.email.toLowerCase() === email.toLowerCase()) {
      return user;
    }
  }
  return null;
}

export async function verifyPassword(user: User, password: string): Promise<boolean> {
  return bcrypt.compare(password, user.password);
}

export function getUserById(id: string): User | null {
  return users.get(id) || null;
}
