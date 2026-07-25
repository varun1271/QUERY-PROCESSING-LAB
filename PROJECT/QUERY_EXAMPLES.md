# Query Engine - Working Examples

## Filter Queries
Show records that match specific conditions:

```
attendance below 75
CGPA above 8.5
attendance less than 80
CGPA greater than 7.0
attendance at least 90
CGPA at most 6.5
```

## Sort Queries
Order records by a column:

```
sort by CGPA
sort by attendance descending
sort by CGPA ascending
order by attendance
sort by CGPA high to low
```

## Group Queries
Aggregate data by categories:

```
count by department
count by dept
department-wise count
CGPA by department
average CGPA by dept
count by placement
group by department
```

## Aggregate Queries
Calculate statistics:

```
average CGPA
avg attendance
mean CGPA
sum of attendance
max CGPA
highest attendance
minimum CGPA
lowest attendance
```

## Top/Bottom Queries
Find best or worst performers:

```
top 10 by CGPA
top 5 students
bottom 10 by attendance
lowest 5 CGPA
```

## Count Queries
Get total records:

```
count
total records
how many students
```

## Show/List Queries
Display data:

```
show all
list students
show records
```

## Complex Queries (with Gemini AI)
When Gemini AI is active, you can ask:

```
show students with CGPA above 8 and attendance below 90
count departments where average CGPA is above 7.5
top 5 students by CGPA who are eligible for placement
average attendance for each department
```

## Tab Quick Reference

| Tab | Example Query | What It Does |
|-----|--------------|--------------|
| **Filter** | `attendance below 75` | Shows rows matching condition |
| **Sort** | `sort by CGPA` | Orders all rows by column |
| **Group** | `count by department` | Groups and counts by category |
| **Aggregate** | `average CGPA` | Calculates single metric |
| **All** | Any query | Handles all types |

## Tips

✅ Use abbreviations: "dept" = "Department", "cgpa" = "CGPA"  
✅ Column names are case-insensitive in queries  
✅ Gemini AI understands natural language better  
✅ Local parsing works for simple, pattern-based queries  
✅ Results limited to 50 rows for performance  
