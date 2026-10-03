#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <inttypes.h>
#include <stdbool.h>
static bool prime(int64_t n){int64_t d=2;while(d*d<=n){if(n%d==0)return false;d++;}return true;}
static int64_t count_primes(int64_t limit){int64_t n=2,count=0;while(n<=limit){if(prime(n))count++;n++;}return count;}
int main(int argc,char**argv){if(argc!=2)return 2;int64_t n=strtoll(argv[1],0,10);printf("%" PRId64 "\n",count_primes(n));return 0;}