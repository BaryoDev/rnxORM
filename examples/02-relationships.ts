/**
 * arnexORM Relationships
 *
 * OneToMany/ManyToOne (Author/Book), include() eager loading, and a
 * ManyToMany relation (Book/Genre) backed by a join table.
 *
 * In your app: import { Entity, PrimaryKey, Column, ManyToOne, OneToMany, ManyToMany, DbContext, PostgreSQLProvider } from "arnexorm";
 * Here we import from "../src" so the example runs against the repo's source.
 */
import "reflect-metadata";
import { Entity, PrimaryKey, Column, ManyToOne, OneToMany, ManyToMany, DbContext } from "../src";
import { PostgreSQLProvider } from "../src/providers";

// Declaration order matters here: TypeScript's decorator metadata embeds a
// direct runtime reference to a property's class type (e.g. Book.author's
// "design:type" is the actual Author class object), and @ManyToMany resolves
// its related-entity function eagerly (to derive the default join table
// name). Both effectively require the referenced class to already exist, so
// Genre and Author are declared before Book. Only one side of a ManyToMany
// needs the decorator — the join table itself is symmetric.
@Entity("ex2_genres")
class Genre {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;
}

@Entity("ex2_authors")
class Author {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @OneToMany(() => Book, (b: Book) => b.author)
    books!: Book[];
}

@Entity("ex2_books")
class Book {
    @PrimaryKey()
    id!: number;

    @Column()
    title!: string;

    @ManyToOne(() => Author, (a: Author) => a.books)
    author!: Author;

    // The ManyToOne decorator above already registered the "authorid" foreign
    // key column in metadata; this field just gives it a typed handle.
    authorid!: number;

    @ManyToMany(() => Genre, undefined, {
        joinTable: "ex2_book_genres",
        joinColumn: "bookid",
        inverseJoinColumn: "genreid",
    })
    genres!: Genre[];
}

async function main() {
    const provider = new PostgreSQLProvider({
        host: process.env.POSTGRES_HOST || "localhost",
        port: process.env.POSTGRES_PORT ? parseInt(process.env.POSTGRES_PORT, 10) : 5433,
        user: process.env.POSTGRES_USER || "postgres",
        password: process.env.POSTGRES_PASSWORD || "postgres",
        database: process.env.POSTGRES_DB || "rnxorm_test",
    });

    const db = new DbContext(provider);
    await db.connect();

    console.log("=== 02: Relationships ===\n");

    // Self-contained: drop this example's tables (join table first, it has
    // foreign keys into the other two).
    await db.executeSqlRaw("DROP TABLE IF EXISTS ex2_book_genres");
    await db.executeSqlRaw("DROP TABLE IF EXISTS ex2_books");
    await db.executeSqlRaw("DROP TABLE IF EXISTS ex2_authors");
    await db.executeSqlRaw("DROP TABLE IF EXISTS ex2_genres");
    await db.ensureCreated();
    console.log("Schema ready: ex2_authors, ex2_books, ex2_genres, ex2_book_genres");

    const authors = db.set(Author);
    const books = db.set(Book);
    const genres = db.set(Genre);

    // --- ManyToOne / OneToMany ---
    const tolkien = new Author();
    tolkien.name = "J.R.R. Tolkien";
    authors.add(tolkien);
    await db.saveChanges();

    const hobbit = new Book();
    hobbit.title = "The Hobbit";
    hobbit.author = tolkien;
    hobbit.authorid = tolkien.id;

    const lotr = new Book();
    lotr.title = "The Lord of the Rings";
    lotr.author = tolkien;
    lotr.authorid = tolkien.id;

    books.addRange([hobbit, lotr]);
    await db.saveChanges();
    console.log(`Created author "${tolkien.name}" (id=${tolkien.id}) with books: ${hobbit.title}, ${lotr.title}`);

    // --- include() eager loading (OneToMany side) ---
    const [loadedAuthor] = await authors.include((a) => a.books).where("id", "=", tolkien.id).toList();
    console.log(`include(a => a.books) -> ${loadedAuthor.name}: [${loadedAuthor.books.map((b) => b.title).join(", ")}]`);

    // --- ManyToMany with join table ---
    const fantasy = new Genre();
    fantasy.name = "Fantasy";
    const classics = new Genre();
    classics.name = "Classics";
    genres.addRange([fantasy, classics]);
    await db.saveChanges();

    // There is no fluent "add to collection" API for many-to-many yet — the
    // join table is a plain table, so it's populated directly.
    await db.executeSqlRaw(
        "INSERT INTO ex2_book_genres (bookid, genreid) VALUES ($1, $2), ($1, $3)",
        [hobbit.id, fantasy.id, classics.id]
    );

    const [bookWithGenres] = await books.include((b) => b.genres).where("id", "=", hobbit.id).toList();
    console.log(
        `include(b => b.genres) -> ${bookWithGenres.title}: [${bookWithGenres.genres.map((g) => g.name).join(", ")}]`
    );

    await db.disconnect();
    console.log("\nDisconnected. Relationships example complete.");
}

main().catch((err) => {
    console.error("Relationships example failed:", err);
    process.exit(1);
});
