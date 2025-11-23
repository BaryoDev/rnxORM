import { Entity, Column, PrimaryKey } from "../src/decorators";
import { DbContext } from "../src/core/DbContext";
import dotenv from "dotenv";

dotenv.config();

@Entity("users")
class User {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @Column()
    age!: number;
}

async function main() {
    const db = new DbContext({
        host: process.env.DB_HOST || "localhost",
        port: parseInt(process.env.DB_PORT || "5432"),
        user: process.env.DB_USER || "postgres",
        password: process.env.DB_PASSWORD || "postgres",
        database: process.env.DB_NAME || "postgres",
    });

    try {
        console.log("Connecting to database...");
        await db.connect();
        console.log("Connected.");

        console.log("Ensuring schema...");
        await db.ensureCreated();
        console.log("Schema created.");

        const users = db.set(User);

        console.log("Adding user...");
        const newUser = new User();
        newUser.name = "John Doe";
        newUser.age = 30;
        await users.add(newUser);
        console.log("User added.");

        console.log("Querying users...");
        const allUsers = await users.toList();
        console.log("All Users:", allUsers);

        console.log("Querying users with age > 20...");
        const filteredUsers = await users.where("age", ">", 20).toList();
        console.log("Filtered Users:", filteredUsers);

        if (allUsers.length > 0) {
            const userToUpdate = allUsers[0];
            console.log(`Updating user ${userToUpdate.name}...`);
            userToUpdate.age = 31;
            await users.update(userToUpdate);
            console.log("User updated.");

            const updatedUser = (await users.where("id", "=", userToUpdate.id).toList())[0];
            console.log("Updated User:", updatedUser);

            console.log(`Removing user ${userToUpdate.name}...`);
            await users.remove(userToUpdate);
            console.log("User removed.");

            const remainingUsers = await users.toList();
            console.log("Remaining Users:", remainingUsers);
        }

    } catch (error) {
        console.error("Error:", error);
    } finally {
        await db.disconnect();
    }
}

main();
